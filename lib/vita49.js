// VITA-49 (VRT) UDP packet parser for FlexRadio DAX IQ data
// Receives VITA-49 packets containing interleaved float32 I/Q sample pairs
const dgram = require('dgram');
const { EventEmitter } = require('events');

// VITA-49 header constants
const VITA49_HEADER_WORDS = 7; // 28 bytes: header(4) + streamId(4) + classId(8) + timestamp(12)
const VITA49_HEADER_BYTES = VITA49_HEADER_WORDS * 4;
const VITA49_TRAILER_WORDS = 1; // 4 bytes trailer
const VITA49_TRAILER_BYTES = VITA49_TRAILER_WORDS * 4;

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
      console.log(`[VITA-49] Listening on ${addr.address}:${addr.port}`);
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
  }

  _parsePacket(buf) {
    if (buf.length < VITA49_HEADER_BYTES) return; // Too short

    // --- Parse VITA-49 header (big-endian) ---
    // Word 0: [31:28] packet type, [27:24] indicators, [23:20] TSI, [19:16] TSF,
    //         [15:4] packet count (seq), [3:0] packet size (in 32-bit words)
    const word0 = buf.readUInt32BE(0);
    const packetType = (word0 >>> 28) & 0x0F;
    const seq = (word0 >>> 16) & 0x0F; // 4-bit sequence counter
    const packetSizeWords = word0 & 0xFFFF;

    // Validate packet type — we want IF Data with Stream ID
    if (packetType !== PACKET_TYPE_IF_DATA_WITH_STREAM) return;

    // Word 1: Stream ID
    const streamId = buf.readUInt32BE(4);

    // Filter by stream ID if set
    if (this._streamFilter != null && streamId !== this._streamFilter) return;

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

    // Payload starts after header, ends before trailer
    // FlexRadio VITA-49: header=7 words, trailer=1 word
    const payloadStart = VITA49_HEADER_BYTES;
    const payloadEnd = buf.length - VITA49_TRAILER_BYTES;

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
