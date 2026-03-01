// SmartSDR TCP API client — adapted for CW CAT
// Handles radio connection, DAX IQ stream creation, slice management, and spot pushing
const net = require('net');
const { EventEmitter } = require('events');

const SPOT_COLOR = '#FF4FC3F7'; // light blue for skimmer spots
const SPOT_LIFETIME = 120;

class SmartSdrClient extends EventEmitter {
  constructor() {
    super();
    this._sock = null;
    this._seq = 1;
    this._buf = '';
    this._reconnectTimer = null;
    this.connected = false;
    this._host = null;
    this._clientHandle = null;
    this._activeSpots = new Set();
    this._previousSpots = new Set();
    this._spotFreqs = new Map();
    this._streamId = null; // DAX IQ stream ID
    this._udpPort = null;  // UDP port for VITA-49 data
    this._slices = new Map();  // slice index → slice info
    this._panadapters = new Map(); // pan ID → pan info
    this._pendingCallbacks = new Map(); // seq → callback
  }

  connect(host) {
    this.disconnect();
    this._host = host || '127.0.0.1';
    this._doConnect();
  }

  _doConnect() {
    const sock = new net.Socket();
    sock.setNoDelay(true);
    this._sock = sock;

    sock.on('connect', () => {
      this.connected = true;
      // Capture our local IP address (the radio will send UDP data here)
      this._localIp = sock.localAddress;
      console.log(`[SmartSDR] Connected from local IP ${this._localIp}`);
      // Register our UDP port for VITA-49 data
      if (this._udpPort) {
        console.log(`[SmartSDR] Registering UDP port ${this._udpPort} for VITA-49 data`);
        this._sendWithCallback(`client udpport ${this._udpPort}`, (status, msg) => {
          if (status === 0) {
            console.log(`[SmartSDR] UDP port registered OK`);
          } else {
            console.log(`[SmartSDR] UDP port registration failed: 0x${status.toString(16)} ${msg}`);
          }
        });
      }
      this._send('sub client all');
      this._send('sub slice all');
      this._send('sub pan all');
      this.emit('connected');
    });

    sock.on('data', (chunk) => {
      this._buf += chunk.toString();
      let nl;
      while ((nl = this._buf.indexOf('\n')) !== -1) {
        const line = this._buf.slice(0, nl).replace(/\r$/, '');
        this._buf = this._buf.slice(nl + 1);
        this._handleLine(line);
      }
    });

    sock.on('error', (err) => {
      this.emit('error', err);
    });

    sock.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this._sock = null;
      this._streamId = null;
      if (wasConnected) this.emit('disconnected');
      this._scheduleReconnect();
    });

    sock.connect(4992, this._host);
  }

  _handleLine(line) {
    // Client handle
    const hMatch = line.match(/^H([0-9A-Fa-f]+)/);
    if (hMatch) {
      this._clientHandle = hMatch[1];
      console.log(`[SmartSDR] handle: ${this._clientHandle}`);
      return;
    }

    // Version
    if (line.startsWith('V')) {
      console.log(`[SmartSDR] version: ${line.slice(1)}`);
      return;
    }

    // Status messages
    if (line.startsWith('S')) {
      this._parseStatusMessage(line);
      return;
    }

    // Command responses: R<seq>|<status code>|<message>
    const rMatch = line.match(/^R(\d+)\|([0-9A-Fa-f]+)\|?(.*)/);
    if (rMatch) {
      const seq = parseInt(rMatch[1]);
      const status = parseInt(rMatch[2], 16);
      const message = rMatch[3] || '';

      // Check for pending callback
      const cb = this._pendingCallbacks.get(seq);
      if (cb) {
        this._pendingCallbacks.delete(seq);
        cb(status, message);
        return;
      }

      // Log all responses for debugging
      if (status !== 0) {
        console.log(`[SmartSDR] R${seq} error: 0x${status.toString(16)}|${message}`);
        this.emit('cmd-error', { seq, status, message });
      } else {
        console.log(`[SmartSDR] R${seq} OK: ${message}`);
      }
    }
  }

  _parseStatusMessage(line) {
    // Parse slice status: S<handle>|slice <index> <key=value ...>
    const sliceMatch = line.match(/\|slice\s+(\d+)\s+(.*)/);
    if (sliceMatch) {
      const idx = parseInt(sliceMatch[1]);
      const params = this._parseKeyValue(sliceMatch[2]);
      const existing = this._slices.get(idx) || {};
      this._slices.set(idx, { ...existing, ...params, index: idx });
      this.emit('slice', this._slices.get(idx));
      return;
    }

    // Parse panadapter status: S<handle>|display pan <id> <key=value ...>
    const panMatch = line.match(/\|display\s+pan\s+(0x[0-9A-Fa-f]+)\s+(.*)/);
    if (panMatch) {
      const panId = panMatch[1];
      const params = this._parseKeyValue(panMatch[2]);
      const existing = this._panadapters.get(panId) || {};
      this._panadapters.set(panId, { ...existing, ...params, id: panId });
      this.emit('panadapter', this._panadapters.get(panId));
      return;
    }

    // Parse DAX IQ stream status
    const streamMatch = line.match(/\|stream\s+(0x[0-9A-Fa-f]+)\s+(.*)/);
    if (streamMatch) {
      const params = this._parseKeyValue(streamMatch[2]);
      if (params.type === 'dax_iq') {
        this.emit('dax-iq-stream', { id: streamMatch[1], ...params });
      }
    }
  }

  _parseKeyValue(str) {
    const result = {};
    const pairs = str.match(/(\S+?)=(\S+)/g) || [];
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      result[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return result;
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this.connected && this._host) {
        this._doConnect();
      }
    }, 5000);
  }

  _send(cmd) {
    if (!this._sock || !this.connected) return null;
    const seq = this._seq++;
    this._sock.write(`C${seq}|${cmd}\n`);
    return seq;
  }

  _sendWithCallback(cmd, cb) {
    const seq = this._send(cmd);
    if (seq != null) {
      this._pendingCallbacks.set(seq, cb);
    }
    return seq;
  }

  /**
   * Set the UDP port for VITA-49 data before connecting.
   * Must be called before connect().
   */
  setUdpPort(port) {
    this._udpPort = port;
  }

  /**
   * Create a DAX IQ stream for wideband IQ data reception.
   * @param {number} channel - DAX IQ channel number (1-4)
   * @param {number} rate - Sample rate: 48000, 96000, or 192000
   * @param {Function} cb - Callback(err, streamId)
   */
  createDaxIqStream(channel, rate, cb) {
    const ip = this._localIp || '127.0.0.1';
    const port = this._udpPort || 0;

    // Try multiple command syntaxes — FlexRadio API varies by firmware version
    const attempts = [
      // v1.x with explicit ip/port
      `stream create daxiq=${channel} ip=${ip} port=${port}`,
      // v1.x without ip/port (relies on client udpport)
      `stream create daxiq=${channel}`,
      // v2.x+ typed syntax
      `stream create type=dax_iq daxiq_channel=${channel}`,
    ];

    const tryNext = (idx) => {
      if (idx >= attempts.length) {
        cb(new Error('Failed to create DAX IQ stream: all command syntaxes rejected'));
        return;
      }
      const cmd = attempts[idx];
      console.log(`[SmartSDR] Trying: ${cmd}`);
      this._sendWithCallback(cmd, (status, message) => {
        if (status === 0) {
          this._streamId = this._parseStreamId(message);
          console.log(`[SmartSDR] DAX IQ stream created: ${this._streamId} (syntax #${idx + 1})`);

          // Set sample rate separately (rate in kHz shorthand: 48, 96, 192)
          const rateKhz = Math.round(rate / 1000);
          this._send(`stream set ${this._streamId} daxiq_rate=${rateKhz}`);
          console.log(`[SmartSDR] Set DAX IQ rate to ${rateKhz} kHz`);

          cb(null, this._streamId);
        } else {
          console.log(`[SmartSDR] Syntax #${idx + 1} failed: 0x${status.toString(16)} ${message}`);
          tryNext(idx + 1);
        }
      });
    };

    tryNext(0);
  }

  /**
   * Parse a stream ID from a response message, ensuring 0x prefix.
   */
  _parseStreamId(message) {
    // Try to find 0x-prefixed hex first
    const withPrefix = message.match(/(0x[0-9A-Fa-f]+)/);
    if (withPrefix) return withPrefix[1];
    // Otherwise take the raw hex value and add 0x prefix
    const raw = message.trim().match(/([0-9A-Fa-f]+)/);
    if (raw) return '0x' + raw[1];
    return message.trim();
  }

  /**
   * Remove the active DAX IQ stream.
   */
  removeDaxIqStream() {
    if (this._streamId) {
      this._send(`stream remove ${this._streamId}`);
      this._streamId = null;
    }
  }

  /**
   * Set DAX IQ channel on a panadapter to route IQ data to the stream.
   * @param {string} panId - Panadapter ID (hex, e.g., '0x40000000')
   * @param {number} channel - DAX IQ channel number (1-4)
   */
  setPanDaxIq(panId, channel) {
    this._send(`display pan set ${panId} daxiq_channel=${channel}`);
    console.log(`[SmartSDR] Set panadapter ${panId} DAX IQ channel to ${channel}`);
  }

  /**
   * Get the first known panadapter ID.
   */
  getFirstPanadapterId() {
    for (const [id] of this._panadapters) {
      return id;
    }
    return null;
  }

  /**
   * Get current center frequency of a slice in MHz.
   */
  getSliceFreq(sliceIndex) {
    const slice = this._slices.get(sliceIndex);
    return slice ? parseFloat(slice.RF_frequency || slice.freq || 0) : 0;
  }

  addSpot(spot) {
    const freqMHz = spot.freqMHz;
    if (!freqMHz || isNaN(freqMHz)) return;
    const callsign = (spot.callsign || '').replace(/\s/g, '');
    if (!callsign) return;
    const color = SPOT_COLOR;
    const lifetime = SPOT_LIFETIME;
    const comment = (spot.comment || '').slice(0, 40).replace(/\s/g, '_');

    const prevFreq = this._spotFreqs.get(callsign);
    if (prevFreq !== undefined && Math.abs(prevFreq - freqMHz) > 0.0005) {
      this._send(`spot remove callsign=${callsign} source=CW-CAT`);
    }

    this._send(
      `spot add rx_freq=${freqMHz.toFixed(6)} callsign=${callsign} mode=CW color=${color} source=CW-CAT trigger_action=tune lifetime_seconds=${lifetime}` +
      (comment ? ` comment=${comment}` : '')
    );
    this._activeSpots.add(callsign);
    this._spotFreqs.set(callsign, freqMHz);
  }

  pruneStaleSpots() {
    for (const call of this._previousSpots) {
      if (!this._activeSpots.has(call)) {
        this._send(`spot remove callsign=${call} source=CW-CAT`);
        this._spotFreqs.delete(call);
      }
    }
    this._previousSpots = new Set(this._activeSpots);
    this._activeSpots.clear();
  }

  clearSpots() {
    this._send('spot clear');
    this._activeSpots.clear();
    this._previousSpots.clear();
    this._spotFreqs.clear();
  }

  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.removeDaxIqStream();
    this._host = null;
    if (this._sock) {
      try {
        this._sock.end();
        const sock = this._sock;
        setTimeout(() => { try { sock.destroy(); } catch {} }, 500);
      } catch { /* ignore */ }
      this._sock = null;
    }
    this.connected = false;
  }
}

module.exports = { SmartSdrClient };
