'use strict';

/**
 * Mongo-backed Baileys auth state.
 *
 * Persists creds + signal keys to AuthState collection so sessions
 * survive Railway redeploys (ephemeral filesystem safe).
 *
 * Implements the interface expected by makeWASocket:
 *   { state: { creds, keys }, saveCreds }
 */
const AuthState = require('../models/authState.model');

function jsonStringify(value) {
  return JSON.stringify(value, (_k, v) => {
    if (v instanceof Uint8Array) return { type: 'Buffer', data: Buffer.from(v).toString('base64') };
    if (Buffer.isBuffer(v)) return { type: 'Buffer', data: v.toString('base64') };
    return v;
  });
}

function jsonParse(str) {
  if (str == null) return null;
  return JSON.parse(str, (_k, v) => {
    if (v && typeof v === 'object' && v.type === 'Buffer' && typeof v.data === 'string') {
      return Buffer.from(v.data, 'base64');
    }
    return v;
  });
}

async function readEntry(sessionId, key) {
  const doc = await AuthState.findOne({ session_id: sessionId, key }).lean();
  if (!doc || doc.value == null) return null;
  try {
    return typeof doc.value === 'string' ? jsonParse(doc.value) : doc.value;
  } catch {
    return null;
  }
}

async function writeEntry(sessionId, key, value) {
  const serialized = jsonStringify(value);
  await AuthState.updateOne(
    { session_id: sessionId, key },
    { $set: { value: serialized } },
    { upsert: true }
  );
}

async function removeEntry(sessionId, key) {
  await AuthState.deleteOne({ session_id: sessionId, key });
}

async function clearSession(sessionId) {
  await AuthState.deleteMany({ session_id: sessionId });
}

async function useMongoAuthState(sessionId, baileys) {
  const { initAuthCreds, BufferJSON, proto } = baileys;
  // BufferJSON handles serialization for signal keys
  const stringify = (v) => JSON.stringify(v, BufferJSON.replacer);
  const parse = (s) => JSON.parse(s, BufferJSON.reviver);

  async function read(key) {
    const doc = await AuthState.findOne({ session_id: sessionId, key }).lean();
    if (!doc || doc.value == null) return null;
    try {
      return typeof doc.value === 'string' ? parse(doc.value) : doc.value;
    } catch {
      return null;
    }
  }
  async function write(key, value) {
    if (value == null) {
      await AuthState.deleteOne({ session_id: sessionId, key });
      return;
    }
    await AuthState.updateOne(
      { session_id: sessionId, key },
      { $set: { value: stringify(value) } },
      { upsert: true }
    );
  }

  const creds = (await read('creds')) || initAuthCreds();

  const keys = {
    get: async (type, ids) => {
      const out = {};
      await Promise.all(
        ids.map(async (id) => {
          let v = await read(`${type}-${id}`);
          if (type === 'app-state-sync-key' && v) {
            v = proto.Message.AppStateSyncKeyData.fromObject(v);
          }
          if (v) out[id] = v;
        })
      );
      return out;
    },
    set: async (data) => {
      const tasks = [];
      for (const type of Object.keys(data)) {
        for (const id of Object.keys(data[type])) {
          tasks.push(write(`${type}-${id}`, data[type][id]));
        }
      }
      await Promise.all(tasks);
    },
  };

  return {
    state: { creds, keys },
    saveCreds: () => write('creds', creds),
  };
}

module.exports = {
  useMongoAuthState,
  clearSession,
  readEntry,
  writeEntry,
  removeEntry,
};
