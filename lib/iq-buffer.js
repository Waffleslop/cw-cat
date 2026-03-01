// Ring buffer for IQ sample accumulation
// Producer: VITA-49 UDP receiver writes interleaved I/Q float32 samples
// Consumer: DSP worker reads fixed-size blocks for FFT processing

class IqRingBuffer {
  /**
   * @param {number} capacity - Total capacity in sample pairs (I+Q = 2 floats per pair)
   * @param {number} blockSize - Number of sample pairs per output block
   */
  constructor(capacity, blockSize) {
    this._blockSize = blockSize;
    // Buffer stores interleaved I/Q: each sample pair = 2 floats
    this._bufferLen = capacity * 2;
    this._buffer = new Float32Array(this._bufferLen);
    this._writePos = 0;
    this._readPos = 0;
    this._count = 0; // number of floats available
    this._overlapRatio = 0.5; // 50% overlap for FFT blocks
  }

  /**
   * Write interleaved I/Q samples into the ring buffer.
   * Returns an array of complete blocks ready for processing.
   * @param {Float32Array} samples - Interleaved I/Q float32 data
   * @returns {Float32Array[]} - Array of complete blocks (each blockSize*2 floats)
   */
  write(samples) {
    const blocks = [];
    const len = samples.length;

    // Copy into ring buffer
    for (let i = 0; i < len; i++) {
      this._buffer[this._writePos] = samples[i];
      this._writePos = (this._writePos + 1) % this._bufferLen;
    }
    this._count += len;

    // Cap count at buffer length (drop oldest if overflow)
    if (this._count > this._bufferLen) {
      const overflow = this._count - this._bufferLen;
      this._readPos = (this._readPos + overflow) % this._bufferLen;
      this._count = this._bufferLen;
    }

    // Extract complete blocks with overlap
    const blockFloats = this._blockSize * 2; // I+Q interleaved
    const stepFloats = Math.floor(blockFloats * (1 - this._overlapRatio));

    while (this._count >= blockFloats) {
      const block = new Float32Array(blockFloats);

      // Copy from ring buffer (may wrap around)
      let pos = this._readPos;
      for (let i = 0; i < blockFloats; i++) {
        block[i] = this._buffer[pos];
        pos = (pos + 1) % this._bufferLen;
      }

      blocks.push(block);

      // Advance read position by step (not full block, for overlap)
      this._readPos = (this._readPos + stepFloats) % this._bufferLen;
      this._count -= stepFloats;
    }

    return blocks;
  }

  /**
   * Reset the buffer state.
   */
  reset() {
    this._writePos = 0;
    this._readPos = 0;
    this._count = 0;
  }
}

module.exports = { IqRingBuffer };
