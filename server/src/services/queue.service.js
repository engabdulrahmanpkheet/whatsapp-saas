'use strict';

const Campaign = require('../models/campaign.model');
const License = require('../models/license.model');

const LOCK_TIMEOUT_MS = 2 * 60 * 1000;
const todayUTC = () => new Date().toISOString().slice(0, 10);

async function reclaimStale(campaignId) {
  const cutoff = new Date(Date.now() - LOCK_TIMEOUT_MS);
  await Campaign.updateOne(
    { _id: campaignId },
    {
      $set: {
        'contacts.$[stuck].status': 'pending',
        'contacts.$[stuck].locked_at': null,
      },
    },
    {
      arrayFilters: [{ 'stuck.status': 'processing', 'stuck.locked_at': { $lt: cutoff } }],
    }
  );
}

function effectiveDailyCap(campaign, license) {
  const licCap = license.max_messages_per_day || 0;
  if (!campaign.warmup?.enabled) return licCap;
  const start = campaign.warmup.started_at || campaign.createdAt || new Date();
  const days = Math.max(0, Math.floor((Date.now() - new Date(start).getTime()) / 86_400_000));
  const warmCap = (campaign.warmup.day1 || 50) + days * (campaign.warmup.day_step || 50);
  if (!licCap) return warmCap;
  return Math.min(licCap, warmCap);
}

async function claimNextJob(licenseKey, campaignId) {
  await reclaimStale(campaignId);

  const license = await License.findOne({ license_key: licenseKey });
  if (!license) return { error: 'license_missing' };

  const campaign = await Campaign.findOne({ _id: campaignId, license_key: licenseKey });
  if (!campaign) return { error: 'campaign_missing' };
  if (campaign.status === 'paused') return { error: 'paused' };
  if (campaign.status === 'completed') return null;

  if (campaign.sent_today.date !== todayUTC()) {
    campaign.sent_today = { date: todayUTC(), count: 0 };
    await campaign.save();
  }

  if (campaign.warmup?.enabled && !campaign.warmup.started_at) {
    campaign.warmup.started_at = new Date();
    await campaign.save();
  }

  const cap = effectiveDailyCap(campaign, license);
  if (cap > 0 && campaign.sent_today.count >= cap) {
    return { error: 'daily_quota_reached', limit: cap, warmup: !!campaign.warmup?.enabled };
  }

  const now = new Date();
  const claimed = await Campaign.findOneAndUpdate(
    {
      _id: campaignId,
      license_key: licenseKey,
      status: { $in: ['queued', 'running'] },
      'contacts.status': 'pending',
    },
    {
      $set: {
        status: 'running',
        'contacts.$[next].status': 'processing',
        'contacts.$[next].locked_at': now,
      },
      $inc: { 'contacts.$[next].attempts': 1 },
    },
    { new: true, arrayFilters: [{ 'next.status': 'pending' }] }
  );

  if (!claimed) return null;

  const contact = claimed.contacts.find(
    (c) => c.status === 'processing' && c.locked_at && c.locked_at.getTime() === now.getTime()
  );
  if (!contact) return null;
  return { campaign: claimed, contact };
}

async function completeJob(licenseKey, campaignId, contactId) {
  const campaign = await Campaign.findOne({ _id: campaignId, license_key: licenseKey });
  if (!campaign) return null;
  const c = campaign.contacts.id(contactId);
  if (!c) return null;
  c.status = 'sent';
  c.sent_at = new Date();
  c.error = '';
  c.locked_at = null;
  if (campaign.sent_today.date !== todayUTC()) {
    campaign.sent_today = { date: todayUTC(), count: 0 };
  }
  campaign.sent_today.count += 1;
  await campaign.save();
  return campaign;
}

async function failJob(licenseKey, campaignId, contactId, errorMsg = '') {
  const campaign = await Campaign.findOne({ _id: campaignId, license_key: licenseKey });
  if (!campaign) return null;
  const c = campaign.contacts.id(contactId);
  if (!c) return null;
  c.status = 'failed';
  c.error = String(errorMsg).slice(0, 500);
  c.locked_at = null;
  await campaign.save();
  return campaign;
}

async function skipJob(licenseKey, campaignId, contactId, reason = '') {
  const campaign = await Campaign.findOne({ _id: campaignId, license_key: licenseKey });
  if (!campaign) return null;
  const c = campaign.contacts.id(contactId);
  if (!c) return null;
  c.status = 'skipped';
  c.error = String(reason).slice(0, 200);
  c.locked_at = null;
  await campaign.save();
  return campaign;
}

module.exports = {
  claimNextJob,
  completeJob,
  failJob,
  skipJob,
  reclaimStale,
  effectiveDailyCap,
  LOCK_TIMEOUT_MS,
};
