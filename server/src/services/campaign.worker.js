'use strict';

/**
 * Server-side campaign worker.
 *
 * Replaces the role the desktop client used to play: pulls jobs from the
 * Campaign queue and sends them via the in-process WhatsApp manager.
 *
 * One worker per campaign. Workers are started:
 *   - lazily, when /api/campaign/start succeeds
 *   - on boot, for any campaign still in `queued` / `running` state
 *
 * Each worker:
 *   - waits for its session to be `connected`
 *   - claims one job at a time (atomic Mongo update)
 *   - sleeps a random delay within campaign.delay_min..max_seconds
 *   - sends (text or media, with optional typing simulation)
 *   - reports success/failure
 *   - exits cleanly when the campaign is paused, completed, or deleted
 *
 * Workers are NOT a strict guarantee — if the process crashes mid-job the
 * queue layer reclaims the stuck contact after LOCK_TIMEOUT_MS (~2 min).
 */

const env = require('../config/env');
const logger = require('../utils/logger').child({ scope: 'campaign-worker' });
const Campaign = require('../models/campaign.model');
const queue = require('./queue.service');
const manager = require('../whatsapp/manager');
const { buildText } = require('./messageBuilder');

const SESSION_WAIT_MS = 5_000;        // poll session readiness
const SESSION_WAIT_MAX_MS = 5 * 60_000;
const QUOTA_BACKOFF_MS = 60_000;      // when daily cap hit
const PAUSE_BACKOFF_MS = 10_000;
const HARD_FLOOR_MS = (env.HARD_MIN_DELAY_SEC || 5) * 1000;

const workers = new Map(); // campaignId -> CampaignWorker

class CampaignWorker {
  constructor(campaignId, licenseKey) {
    this.campaignId = String(campaignId);
    this.licenseKey = String(licenseKey);
    this.sessionId = this.licenseKey.toUpperCase();
    this.stopped = false;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop().catch((err) => {
      logger.error({ campaignId: this.campaignId, err: err.message }, 'worker loop crashed');
      this.running = false;
      workers.delete(this.campaignId);
    });
  }

  stop() {
    this.stopped = true;
  }

  async waitForSession() {
    const start = Date.now();
    while (!this.stopped) {
      const st = manager.status(this.sessionId);
      if (st.status === 'connected') return true;
      if (Date.now() - start > SESSION_WAIT_MAX_MS) return false;
      await sleep(SESSION_WAIT_MS);
    }
    return false;
  }

  async loop() {
    logger.info({ campaignId: this.campaignId, sessionId: this.sessionId }, 'worker starting');
    while (!this.stopped) {
      try {
        const sessionReady = await this.waitForSession();
        if (this.stopped) break;
        if (!sessionReady) {
          logger.warn({ campaignId: this.campaignId }, 'session not ready after 5m — pausing worker');
          await sleep(60_000);
          continue;
        }

        const result = await queue.claimNextJob(this.licenseKey, this.campaignId);

        if (result === null) {
          logger.info({ campaignId: this.campaignId }, 'campaign complete — worker exiting');
          break;
        }

        if (result.error) {
          if (result.error === 'paused') {
            await sleep(PAUSE_BACKOFF_MS);
            continue;
          }
          if (result.error === 'daily_quota_reached') {
            logger.info(
              { campaignId: this.campaignId, limit: result.limit },
              'daily quota reached — backing off'
            );
            await sleep(QUOTA_BACKOFF_MS);
            continue;
          }
          if (result.error === 'campaign_missing') {
            logger.info({ campaignId: this.campaignId }, 'campaign vanished — worker exiting');
            break;
          }
          // Unknown error — back off mildly.
          logger.warn({ campaignId: this.campaignId, error: result.error }, 'claim error');
          await sleep(10_000);
          continue;
        }

        const { campaign, contact } = result;
        await this.processJob(campaign, contact);
      } catch (err) {
        logger.error(
          { campaignId: this.campaignId, err: err.message },
          'worker iteration error — backing off'
        );
        await sleep(5_000);
      }
    }
    this.running = false;
    workers.delete(this.campaignId);
    logger.info({ campaignId: this.campaignId }, 'worker stopped');
  }

  async processJob(campaign, contact) {
    // Skip auto: red-risk contacts never get sent to.
    if (contact.risk_level === 'red') {
      await queue.skipJob(this.licenseKey, this.campaignId, contact._id, 'risk:red');
      return;
    }
    // Skip if marked not on whatsapp.
    if (contact.on_whatsapp === false) {
      await queue.skipJob(this.licenseKey, this.campaignId, contact._id, 'not_on_whatsapp');
      return;
    }

    // Jittered delay before sending — anti-ban.
    const min = Math.max(HARD_FLOOR_MS, (campaign.delay_min_seconds || 8) * 1000);
    const max = Math.max(min, (campaign.delay_max_seconds || 20) * 1000);
    const wait = min + Math.random() * (max - min);
    await sleep(wait);
    if (this.stopped) return;

    const text = buildText(campaign, contact);

    try {
      if (campaign.media) {
        await manager.sendMedia(this.sessionId, contact.phone, {
          ...campaign.media.toObject?.() ?? campaign.media,
          caption: campaign.media.caption || text,
        });
      } else {
        await manager.sendText(this.sessionId, contact.phone, text);
      }
      await queue.completeJob(this.licenseKey, this.campaignId, contact._id);
    } catch (err) {
      const reason = String(err.message || err).slice(0, 200);
      logger.warn(
        { campaignId: this.campaignId, phone: contact.phone, err: reason },
        'send failed'
      );
      await queue.failJob(this.licenseKey, this.campaignId, contact._id, reason);
      // If the session dropped, wait before next attempt.
      if (reason === 'session_not_connected') await sleep(15_000);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureWorker(campaignId, licenseKey) {
  const key = String(campaignId);
  let w = workers.get(key);
  if (w) return w;
  w = new CampaignWorker(campaignId, licenseKey);
  workers.set(key, w);
  w.start();
  return w;
}

function stopWorker(campaignId) {
  const w = workers.get(String(campaignId));
  if (!w) return false;
  w.stop();
  return true;
}

function stopAll() {
  for (const w of workers.values()) w.stop();
}

function activeWorkers() {
  return Array.from(workers.keys());
}

/**
 * Scan DB for campaigns that still have pending work and start a worker for
 * each. Idempotent — re-running won't create duplicates.
 */
async function resumeOnBoot() {
  const pending = await Campaign.find({
    status: { $in: ['queued', 'running'] },
    'contacts.status': 'pending',
  })
    .select('_id license_key status')
    .limit(500)
    .lean();
  for (const c of pending) {
    ensureWorker(c._id, c.license_key);
  }
  return pending.length;
}

module.exports = { ensureWorker, stopWorker, stopAll, activeWorkers, resumeOnBoot };
