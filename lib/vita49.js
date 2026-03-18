// VITA-49 (VRT) UDP packet parser for FlexRadio DAX IQ data
// Receives VITA-49 packets containing interleaved float32 I/Q sample pairs
const dgram = require('dgram');
const { EventEmitter } = require('events');

// FlexRadio VITA-49 packet types
const PACKET_TYPE_IF_DATA_WITH_STREAM = 0x1;

class VitaReceiver extends EventEmitter {
  constructor(port) {
    super();
    this._port = port || 0; // 0 = OS-assigned; FlexRadio sends to the port we tell it
    this._socket = null;
    this._lastSeq = -1;
    this._packetsReceived = 0;
    this._packetsDropped = 0;
    this._streamFilter = null; // optional: only accept packets from this stream ID
    this._layout = null; // cached header/trailer layout (computed from first packet)
  }

  /**
   * Set the stream ID to filter for (hex string like "0x40000001").
   * If set, only packets matching this stream ID will be processed.
   */
  setStreamFilter(streamId) {
    if (typeof streamId === 'string') {
      this._streamFilter = parseInt(streamId, 16);
    } else {
      this._streamFilter = streamId;
    }
  }

  /**
   * Get the bound UDP port (useful when port=0 for OS-assigned).
   */
  getPort() {
    if (this._socket) {
      return this._socket.address().port;
    }
    return this._port;
  }

  /**
   * Start listening for VITA-49 packets.
   * @param {string} [bindAddress] - IP to bind to (default '0.0.0.0')
   */
  start(bindAddress) {
    if (this._socket) return;

    this._socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this._socket.on('message', (msg, rinfo) => {
      if (this._packetsReceived === 0) {
        console.log(`[VITA-49] First UDP packet from ${rinfo.address}:${rinfo.port}, size=${msg.length} bytes`);
      }
      this._parsePacket(msg);
    });

    this._socket.on('error', (err) => {
      this.emit('error', err);
    });

    this._socket.on('listening', () => {
      const addr = this._socket.address();
      this._port = addr.port;
      // Increase receive buffer to 4MB to reduce packet drops under load
      // Default OS buffer is typically 64-256KB which overflows at 192kHz IQ rates
      try {
        this._socket.setRecvBufferSize(4 * 1024 * 1024);
        console.log(`[VITA-49] Listening on ${addr.address}:${addr.port}, rcvbuf=${this._socket.getRecvBufferSize()} bytes`);
      } catch (err) {
        console.log(`[VITA-49] Listening on ${addr.address}:${addr.port} (rcvbuf set failed: ${err.message})`);
      }
      this.emit('listening', addr.port);
    });

    this._socket.bind(this._port, bindAddress || '0.0.0.0');
  }

  stop() {
    if (this._socket) {
      try { this._socket.close(); } catch {}
      this._socket = null;
    }
    this._lastSeq = -1;
    this._layout = null;
  }

  /**
   * Compute VITA-49 header size from word 0 indicator bits.
   * Header fields: word0(1) + streamId(0-1) + classId(0-2) + intTS(0-1) + fracTS(0-2)
   * Returns { headerBytes, trailerBytes } for payload extraction.
   */
  _computeLayout(word0) {
    const packetType = (word0 >>> 28) & 0x0F;
    const hasClassId  = (word0 >>> 27) & 1; // C bit
    const hasTrailer  = (word0 >>> 26) & 1; // T bit
    const tsi         = (word0 >>> 22) & 3; // Integer timestamp type (0=none)
    const tsf         = (word0 >>> 20) & 3; // Fractional timestamp type (0=none)

    // Stream ID present for packet types with stream identifier (0x1, 0x3, 0x5)
    const hasStreamId = (packetType & 1) === 1;

    let headerWords = 1;                    // word 0 (always)
    if (hasStreamId) headerWords += 1;      // stream ID
    if (hasClassId)  headerWords += 2;      // class ID (OUI + info codes)
    if (tsi !== 0)   headerWords += 1;      // integer timestamp
    if (tsf !== 0)   headerWords += 2;      // fractional timestamp (64-bit)

    return {
      headerBytes:  headerWords * 4,
      trailerBytes: hasTrailer ? 4 : 0,
      hasStreamId,
      hasClassId:  !!hasClassId,
      hasTrailer:  !!hasTrailer,
      tsi,
      tsf,
      headerWords,
    };
  }

  _parsePacket(buf) {
    if (buf.length < 8) return; // Need at least word 0 + stream ID

    // --- Parse VITA-49 header word 0 (big-endian per VRT spec) ---
    const word0 = buf.readUInt32BE(0);
    const packetType = (word0 >>> 28) & 0x0F;
    const seq = (word0 >>> 16) & 0x0F; // 4-bit sequence counter

    // Validate packet type — we want IF Data with Stream ID
    if (packetType !== PACKET_TYPE_IF_DATA_WITH_STREAM) return;

    // Word 1: Stream ID (always present for packet type 0x1)
    const streamId = buf.readUInt32BE(4);

    // Filter by stream ID if set
    if (this._streamFilter != null && streamId !== this._streamFilter) return;

    // Compute header/trailer layout from indicator bits (cache after first packet)
    if (!this._layout) {
      this._layout = this._computeLayout(word0);
      console.log(`[VITA-49] Packet layout: ${this._layout.headerWords}-word header (${this._layout.headerBytes} bytes) — ` +
        `classId=${this._layout.hasClassId}, TSI=${this._layout.tsi}, TSF=${this._layout.tsf}, trailer=${this._layout.hasTrailer}`);
    }
    const { headerBytes, trailerBytes } = this._layout;

    if (buf.length < headerBytes) return; // Packet too short for its header

    // Check sequence continuity
    if (this._lastSeq >= 0) {
      const expected = (this._lastSeq + 1) & 0x0F;
      if (seq !== expected) {
        const gap = (seq - this._lastSeq + 16) & 0x0F;
        this._packetsDropped += gap - 1;
        this.emit('seq-error', { expected, got: seq, dropped: gap - 1 });
      }
    }
    this._lastSeq = seq;
    this._packetsReceived++;

    // Payload: between header and trailer
    const payloadStart = headerBytes;
    const payloadEnd = buf.length - trailerBytes;

    if (payloadEnd <= payloadStart) return;

    const payloadBytes = payloadEnd - payloadStart;
    const numFloats = payloadBytes / 4;
    const samples = new Float32Array(numFloats);

    // Log first packet's raw sample values to determine correct byte order
    if (this._packetsReceived <= 1) {
      const leVal0 = buf.readFloatLE(payloadStart);
      const leVal1 = buf.readFloatLE(payloadStart + 4);
      const beVal0 = buf.readFloatBE(payloadStart);
      const beVal1 = buf.readFloatBE(payloadStart + 4);
      console.log(`[VITA-49] Sample byte order test — LE: I=${leVal0}, Q=${leVal1} | BE: I=${beVal0}, Q=${beVal1}`);
      console.log(`[VITA-49] Raw bytes[0-7]: ${buf.slice(payloadStart, payloadStart + 8).toString('hex')}`);
      console.log(`[VITA-49] Payload: ${numFloats} floats (${numFloats / 2} IQ pairs), ${payloadBytes} bytes`);
    }

    // FlexRadio VITA-49 IQ payload: 32-bit float, little-endian (x86 byte order)
    // Values are NOT normalized to ±1.0 — typical range is ±100 to ±10000
    for (let i = 0; i < numFloats; i++) {
      samples[i] = buf.readFloatLE(payloadStart + i * 4);
    }

    this.emit('iq-data', samples);
  }

  getStats() {
    return {
      received: this._packetsReceived,
      dropped: this._packetsDropped,
    };
  }
}

module.exports = { VitaReceiver };
