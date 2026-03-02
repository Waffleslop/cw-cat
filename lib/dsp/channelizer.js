// Channelizer: extracts a narrow CW channel from wideband IQ data
// Two-stage decimation for effective narrowband filtering:
//   Stage 1: Block averaging (192kHz → 8kHz) — cheap pre-decimation
//   Stage 2: FIR lowpass at 8kHz with 511 taps → 63.9ms filter span → effective narrowband

class CwChannel {
  /**
   * @param {number} freqOffset - Frequency offset from center in Hz
   * @param {number} inputRate - Input sample rate (e.g., 192000)
   * @param {number} outputRate - Output sample rate after decimation (e.g., 800)
   * @param {number} bandwidth - Channel bandwidth in Hz (e.g., 100)
   */
  constructor(freqOffset, inputRate, outputRate, bandwidth) {
    this.freqOffset = freqOffset;
    this._inputRate = inputRate;
    this._bandwidth = bandwidth;

    // Two-stage decimation:
    // Stage 1: block average from inputRate to intermediate rate (~8kHz)
    // Stage 2: FIR lowpass + decimation from intermediate to output rate
    this._stage1Decim = Math.max(1, Math.floor(inputRate / 8000));
    this._intermediateRate = inputRate / this._stage1Decim;
    this._stage2Decim = Math.max(1, Math.round(this._intermediateRate / outputRate));
    this._actualOutputRate = this._intermediateRate / this._stage2Decim;

    // NCO (numerically controlled oscillator) for frequency shifting
    const phaseInc = (-2 * Math.PI * freqOffset) / inputRate;
    this._ncoCosDelta = Math.cos(phaseInc);
    this._ncoSinDelta = Math.sin(phaseInc);
    this._ncoCos = 1.0;
    this._ncoSin = 0.0;
    this._ncoCount = 0;

    // Stage 1: block averager accumulators
    this._accumI = 0;
    this._accumQ = 0;
    this._stage1Count = 0;

    // Stage 2: FIR lowpass filter at intermediate rate
    // 511 taps at 8kHz = 63.9ms span, group delay = 31.9ms
    // Blackman-Harris window: transition BW ≈ 125Hz, stopband rejection ≈ 92dB
    // At 100Hz offset: ~35dB rejection. At 200Hz: >70dB. At 300Hz+: >90dB.
    // Previous 255 taps with Blackman had 376Hz transition — now much sharper
    this._filterLen = 511;
    this._filter = this._designLpf(bandwidth / 2, this._intermediateRate, this._filterLen);

    // Filter delay line (complex)
    this._delayI = new Float32Array(this._filterLen);
    this._delayQ = new Float32Array(this._filterLen);
    this._delayPos = 0;

    // Stage 2 decimation counter
    this._stage2Count = 0;
  }

  /**
   * Design a low-pass FIR filter using windowed sinc method.
   */
  _designLpf(cutoff, sampleRate, numTaps) {
    const coeffs = new Float32Array(numTaps);
    const M = numTaps - 1;
    const fc = cutoff / sampleRate;

    for (let i = 0; i <= M; i++) {
      const n = i - M / 2;
      // Sinc function
      let h;
      if (Math.abs(n) < 1e-10) {
        h = 2 * fc;
      } else {
        h = Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
      }
      // 4-term Blackman-Harris window (92dB stopband, much better than Blackman's 58dB)
      const x = (2 * Math.PI * i) / M;
      const w = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
      coeffs[i] = h * w;
    }

    // Normalize
    let sum = 0;
    for (let i = 0; i < numTaps; i++) sum += coeffs[i];
    for (let i = 0; i < numTaps; i++) coeffs[i] /= sum;

    return coeffs;
  }

  /**
   * Process a block of interleaved I/Q samples.
   * @param {Float32Array} iqBlock - Interleaved I/Q (length = N*2)
   * @returns {Float32Array} - Decimated output: real-valued envelope magnitudes
   */
  process(iqBlock) {
    const numSamples = iqBlock.length / 2;
    const output = [];

    for (let i = 0; i < numSamples; i++) {
      const inI = iqBlock[2 * i];
      const inQ = iqBlock[2 * i + 1];

      // Frequency shift using NCO (incremental rotation — no trig in hot loop)
      const shiftedI = inI * this._ncoCos - inQ * this._ncoSin;
      const shiftedQ = inI * this._ncoSin + inQ * this._ncoCos;

      // Advance NCO
      const newCos = this._ncoCos * this._ncoCosDelta - this._ncoSin * this._ncoSinDelta;
      const newSin = this._ncoSin * this._ncoCosDelta + this._ncoCos * this._ncoSinDelta;
      this._ncoCos = newCos;
      this._ncoSin = newSin;

      // Periodic normalization to prevent amplitude drift
      this._ncoCount++;
      if ((this._ncoCount & 0x3FF) === 0) {
        const invMag = 1.0 / Math.sqrt(this._ncoCos * this._ncoCos + this._ncoSin * this._ncoSin);
        this._ncoCos *= invMag;
        this._ncoSin *= invMag;
      }

      // Stage 1: accumulate for block average (cheap pre-decimation)
      this._accumI += shiftedI;
      this._accumQ += shiftedQ;
      this._stage1Count++;

      if (this._stage1Count >= this._stage1Decim) {
        // Output averaged sample at intermediate rate
        const invDecim = 1.0 / this._stage1Decim;
        const avgI = this._accumI * invDecim;
        const avgQ = this._accumQ * invDecim;
        this._accumI = 0;
        this._accumQ = 0;
        this._stage1Count = 0;

        // Insert into FIR delay line at intermediate rate
        this._delayI[this._delayPos] = avgI;
        this._delayQ[this._delayPos] = avgQ;

        // Stage 2: FIR + decimation
        this._stage2Count++;
        if (this._stage2Count >= this._stage2Decim) {
          this._stage2Count = 0;

          // Apply FIR filter
          let filtI = 0, filtQ = 0;
          let pos = this._delayPos;
          for (let k = 0; k < this._filterLen; k++) {
            filtI += this._filter[k] * this._delayI[pos];
            filtQ += this._filter[k] * this._delayQ[pos];
            pos--;
            if (pos < 0) pos = this._filterLen - 1;
          }

          // Output magnitude (envelope)
          const mag = Math.sqrt(filtI * filtI + filtQ * filtQ);
          output.push(mag);
        }

        this._delayPos = (this._delayPos + 1) % this._filterLen;
      }
    }

    return new Float32Array(output);
  }

  /**
   * Update the frequency offset (for tracking drift).
   */
  setFreqOffset(freqOffset) {
    this.freqOffset = freqOffset;
    const phaseInc = (-2 * Math.PI * freqOffset) / this._inputRate;
    this._ncoCosDelta = Math.cos(phaseInc);
    this._ncoSinDelta = Math.sin(phaseInc);
    this._ncoCos = 1.0;
    this._ncoSin = 0.0;
    this._ncoCount = 0;
  }

  get outputRate() { return this._actualOutputRate; }
}

/**
 * Manages multiple CW channels for simultaneous decoding.
 */
class Channelizer {
  /**
   * @param {number} inputRate - Wideband input sample rate
   * @param {number} channelRate - Per-channel output rate (default 800 Hz)
   * @param {number} channelBw - Per-channel bandwidth (default 100 Hz)
   */
  constructor(inputRate, channelRate, channelBw) {
    this._inputRate = inputRate;
    this._channelRate = channelRate || 800;
    this._channelBw = channelBw || 100;
    this._channels = new Map(); // freqOffset → CwChannel
  }

  /**
   * Add a channel at the given frequency offset.
   * @param {number} freqOffset - Hz offset from center frequency
   * @returns {CwChannel}
   */
  addChannel(freqOffset) {
    const key = Math.round(freqOffset);
    if (this._channels.has(key)) return this._channels.get(key);

    const ch = new CwChannel(freqOffset, this._inputRate, this._channelRate, this._channelBw);
    this._channels.set(key, ch);
    return ch;
  }

  removeChannel(freqOffset) {
    const key = Math.round(freqOffset);
    this._channels.delete(key);
  }

  processAll(iqBlock) {
    const results = new Map();
    for (const [key, ch] of this._channels) {
      results.set(key, ch.process(iqBlock));
    }
    return results;
  }

  getChannels() {
    return Array.from(this._channels.keys());
  }

  clear() {
    this._channels.clear();
  }

  get channelCount() { return this._channels.size; }
}

module.exports = { CwChannel, Channelizer };
