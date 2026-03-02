// Telemetry client — anonymous usage data for beta testing
// No external deps: uses Node built-in https, crypto, fs, os
'use strict';

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UPLOAD_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CACHED_PAYLOADS = 10;

class TelemetryClient {
  constructor({ settingsPath, version, getUserData }) {
    this._settingsPath = settingsPath;
    this._version = version;
    this._getUserData = getUserData; // function returning userData dir path
    this._endpoint = 'https://telemetry.potacat.com/cwcat/ingest';

    // IDs
    this._betaId = null;
    this._sessionId = crypto.randomUUID();
    this._sessionStart = new Date().toISOString();

    // Accumulated data (reset after each upload)
    this._spots = [];
    this._channelsCreated = 0;
    this._channelsEvicted = 0;
    this._channelPeak = 0;
    this._packetsRx = 0;
    this._packetsDrop = 0;
    this._spotterCall = '';

    this._timer = null;
    this._lastUploadTime = Date.now();
  }

  start() {
    this._betaId = this._loadOrCreateBetaId();
    this._retryCachedPayloads();
    this._timer = setInterval(() => this._upload(), UPLOAD_INTERVAL_MS);
    console.log(`[Telemetry] Started — betaId=${this._betaId.slice(0, 8)}…, session=${this._sessionId.slice(0, 8)}…`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // Final upload (best-effort, don't block quit)
    this._upload();
  }

  recordSpot(spot) {
    this._spots.push({
      call: spot.callsign,
      fKhz: Math.round(spot.freqKhz * 10) / 10,
      snr: spot.snr || 0,
      wpm: spot.wpm || 0,
      type: spot.type || '',
      band: spot.band || '',
      entity: spot.entity || '',
      txt: (spot.text || '').slice(-80),
      t: spot.time || new Date().toISOString(),
    });
  }

  recordChannelCreated() {

    this._channelsCreated++;
  }

  recordChannelEvicted() {

    this._channelsEvicted++;
  }

  updateChannelPeak(count) {

    if (count > this._channelPeak) this._channelPeak = count;
  }

  updatePacketStats(rx, drop) {
    this._packetsRx = rx;
    this._packetsDrop = drop;
  }

  setSpotterCall(call) {
    this._spotterCall = call || '';
  }

  // --- Private ---

  _loadOrCreateBetaId() {
    try {
      const settings = JSON.parse(fs.readFileSync(this._settingsPath, 'utf-8'));
      if (settings.betaId) return settings.betaId;
    } catch { /* no settings file yet */ }

    const betaId = crypto.randomUUID();
    try {
      let settings = {};
      try { settings = JSON.parse(fs.readFileSync(this._settingsPath, 'utf-8')); } catch {}
      settings.betaId = betaId;
      fs.writeFileSync(this._settingsPath, JSON.stringify(settings, null, 2));
    } catch (err) {
      console.error('[Telemetry] Failed to persist betaId:', err.message);
    }
    return betaId;
  }

  _buildPayload() {
    const now = new Date();
    const durationSec = Math.round((Date.now() - this._lastUploadTime) / 1000);
    return {
      v: 1,
      betaId: this._betaId,
      sessionId: this._sessionId,
      ts: now.toISOString(),
      version: this._version,
      spotterCall: this._spotterCall,
      os: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
      },
      session: {
        startTime: this._sessionStart,
        durationSec,
      },
      spots: this._spots.slice(), // copy
      channels: {
        created: this._channelsCreated,
        evicted: this._channelsEvicted,
        peak: this._channelPeak,
      },
      packets: {
        rx: this._packetsRx,
        drop: this._packetsDrop,
      },
    };
  }

  _resetAccumulators() {
    this._spots = [];
    this._channelsCreated = 0;
    this._channelsEvicted = 0;
    this._channelPeak = 0;
    // Don't reset packet stats — they're running totals from vita49
    this._lastUploadTime = Date.now();
  }

  _upload() {
    if (!this._betaId) return;

    const payload = this._buildPayload();
    // Skip empty payloads (no spots and no channels)
    if (payload.spots.length === 0 && payload.channels.created === 0 && payload.packets.rx === 0) {
      return;
    }

    this._resetAccumulators();
    this._sendPayload(payload);
  }

  _sendPayload(payload) {
    const body = JSON.stringify(payload);
    const url = new URL(this._endpoint);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[Telemetry] Uploaded: ${payload.spots.length} spots, ${payload.channels.created} ch created`);
        } else {
          console.warn(`[Telemetry] Upload failed (HTTP ${res.statusCode}), caching`);
          this._cachePayload(payload);
        }
      });
    });

    req.on('error', () => {
      this._cachePayload(payload);
    });

    req.on('timeout', () => {
      req.destroy();
      this._cachePayload(payload);
    });

    req.write(body);
    req.end();
  }

  _getCachePath() {
    return path.join(this._getUserData(), 'telemetry-cache.json');
  }

  _cachePayload(payload) {
    try {
      const cachePath = this._getCachePath();
      let cache = [];
      try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')); } catch {}
      if (!Array.isArray(cache)) cache = [];
      cache.push(payload);
      // Keep only the most recent payloads
      if (cache.length > MAX_CACHED_PAYLOADS) {
        cache = cache.slice(-MAX_CACHED_PAYLOADS);
      }
      fs.writeFileSync(cachePath, JSON.stringify(cache));
    } catch (err) {
      console.error('[Telemetry] Cache write failed:', err.message);
    }
  }

  _retryCachedPayloads() {
    try {
      const cachePath = this._getCachePath();
      if (!fs.existsSync(cachePath)) return;
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (!Array.isArray(cache) || cache.length === 0) return;
      // Clear cache file first (payloads will be re-cached on failure)
      fs.unlinkSync(cachePath);
      console.log(`[Telemetry] Retrying ${cache.length} cached payload(s)`);
      for (const payload of cache) {
        this._sendPayload(payload);
      }
    } catch { /* ignore */ }
  }
}

module.exports = { TelemetryClient };
