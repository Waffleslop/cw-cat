// STFT-based channelizer: extracts multiple CW channels from wideband IQ data
// using a shared Short-Time Fourier Transform instead of per-channel NCO+FIR.
//
// FFT size scales with sample rate to maintain ~10.7ms window / ~93.75Hz bins:
// 192kHz→2048, 96kHz→1024, 48kHz→512, 24kHz→256.
// ~36x fewer float operations than 75 independent NCO+FIR chains.

const FFT = require('fft.js');

class StftChannelizer {
  /**
   * @param {number} inputRate - Wideband input sample rate (e.g., 192000)
   * @param {number} outputRate - Per-channel output rate (default 800 Hz)
   * @param {number} fftSize - STFT FFT size (default 2048)
   */
  constructor(inputRate, outputRate, fftSize) {
    this._inputRate = inputRate;
    this._outputRate = outputRate || 800;
    // Scale FFT size with sample rate to maintain ~10.7ms window duration.
    // At 192kHz: 2048 (10.7ms), at 96kHz: 1024, at 48kHz: 512, at 24kHz: 256.
    // This keeps bin spacing ~93.75 Hz and temporal resolution consistent.
    if (!fftSize) {
      fftSize = Math.pow(2, Math.round(Math.log2(inputRate / 93.75)));
      fftSize = Math.max(64, Math.min(4096, fftSize));
    }
    this._fftSize = fftSize;
    this._binWidth = inputRate / this._fftSize; // Hz per bin

    // Hop size: exact integer for clean output rate
    // 192000 / 800 = 240 samples per hop
    this._hopSize = Math.round(inputRate / this._outputRate);
    this._actualOutputRate = inputRate / this._hopSize;

    // FFT instance and work arrays
    this._fft = new FFT(this._fftSize);
    this._fftInput = this._fft.createComplexArray();   // length = fftSize * 2
    this._fftOutput = this._fft.createComplexArray();   // length = fftSize * 2

    // Blackman-Harris window (matches signal detector's FFT window)
    this._window = this._createBlackmanHarrisWindow(this._fftSize);

    // Overlap buffer: carries remaining samples between processBlock calls
    // May be up to fftSize-1 samples (when the last hop barely didn't fit)
    // Stored as interleaved I/Q (length = maxOverlap * 2)
    this._maxOverlap = this._fftSize; // Worst case: almost a full FFT of leftover
    this._overlapBuf = new Float32Array(this._maxOverlap * 2);
    this._overlapValid = 0; // How many overlap samples are valid (0 on first call)

    // Active channels: Map of rounded freqOffset → { key, binIndex, binFrac }
    this._channels = new Map();
  }

  _createBlackmanHarrisWindow(N) {
    const w = new Float32Array(N);
    const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
    for (let i = 0; i < N; i++) {
      const x = (2 * Math.PI * i) / (N - 1);
      w[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x) - a3 * Math.cos(3 * x);
    }
    return w;
  }

  /**
   * Add a channel at the given frequency offset.
   * @param {number} freqOffset - Hz offset from center frequency
   */
  addChannel(freqOffset) {
    const key = Math.round(freqOffset);
    if (this._channels.has(key)) return;

    // Convert freq offset to FFT bin index
    // FFT output: bin 0 = DC, bin N/2 = +Nyquist, bin N-1 = -binWidth
    // For frequency f: bin = f / binWidth (mod N)
    const binExact = freqOffset / this._binWidth;
    // Wrap to [0, N) — negative frequencies map to upper bins
    const binWrapped = ((binExact % this._fftSize) + this._fftSize) % this._fftSize;
    const binIndex = Math.floor(binWrapped);
    const binFrac = binWrapped - binIndex;

    this._channels.set(key, { key, binIndex, binFrac, freqOffset });
  }

  /**
   * Remove a channel by its stable key (Math.round of original freqOffset).
   * @param {number} key - Channel key
   */
  removeChannel(key) {
    this._channels.delete(key);
  }

  /**
   * Update channel frequency (for drift tracking).
   * Only updates the FFT bin — does NOT re-key the channel.
   * The channel key must remain stable to match the worker's channelState key.
   * @param {number} channelKey - The stable channel key (Math.round of original freqOffset)
   * @param {number} newFreqOffset - Updated frequency offset in Hz
   */
  updateChannelFreq(channelKey, newFreqOffset) {
    const ch = this._channels.get(channelKey);
    if (!ch) return;

    const binExact = newFreqOffset / this._binWidth;
    const binWrapped = ((binExact % this._fftSize) + this._fftSize) % this._fftSize;
    ch.binIndex = Math.floor(binWrapped);
    ch.binFrac = binWrapped - ch.binIndex;
    ch.freqOffset = newFreqOffset;
  }

  /**
   * Process a block of interleaved I/Q samples.
   * @param {Float32Array} iqBlock - Interleaved I/Q (length = N*2)
   * @returns {Map<number, Float32Array>} - channelKey → magnitude sequence
   */
  processBlock(iqBlock) {
    const N = this._fftSize;
    const hop = this._hopSize;
    const numInputSamples = iqBlock.length / 2;

    // Build working buffer: overlap from previous call + new samples
    const totalSamples = this._overlapValid + numInputSamples;
    const workBuf = new Float32Array((this._overlapValid + numInputSamples) * 2);

    // Copy overlap
    if (this._overlapValid > 0) {
      workBuf.set(this._overlapBuf.subarray(0, this._overlapValid * 2));
    }
    // Copy new data
    workBuf.set(iqBlock, this._overlapValid * 2);

    // Count how many hops we can do
    const numHops = Math.max(0, Math.floor((totalSamples - N) / hop) + 1);

    // Pre-allocate output arrays for each channel
    const results = new Map();
    if (numHops === 0) {
      // Not enough data yet — update overlap and return empty
      for (const [key] of this._channels) {
        results.set(key, new Float32Array(0));
      }
      // Save all data as overlap for next call
      const newOverlap = Math.min(totalSamples, this._maxOverlap);
      const overlapStart = (totalSamples - newOverlap) * 2;
      this._overlapBuf.set(workBuf.subarray(overlapStart, overlapStart + newOverlap * 2));
      this._overlapValid = newOverlap;
      return results;
    }

    // Allocate output arrays
    const channelOutputs = new Map();
    for (const [key] of this._channels) {
      channelOutputs.set(key, new Float32Array(numHops));
    }

    // Process each hop
    for (let h = 0; h < numHops; h++) {
      const sampleOffset = h * hop;

      // Window and pack into FFT input (interleaved complex)
      const iqOffset = sampleOffset * 2;
      for (let i = 0; i < N; i++) {
        const w = this._window[i];
        this._fftInput[2 * i] = workBuf[iqOffset + 2 * i] * w;
        this._fftInput[2 * i + 1] = workBuf[iqOffset + 2 * i + 1] * w;
      }

      // FFT
      this._fft.transform(this._fftOutput, this._fftInput);

      // Extract magnitude for each channel using peak bin + neighbor energy
      // No EMA smoothing — the downstream envelope detector handles that
      for (const [key, ch] of this._channels) {
        const b0 = ch.binIndex;
        const b1 = (b0 + 1) % N;

        const re0 = this._fftOutput[2 * b0];
        const im0 = this._fftOutput[2 * b0 + 1];
        const mag0sq = re0 * re0 + im0 * im0;

        const re1 = this._fftOutput[2 * b1];
        const im1 = this._fftOutput[2 * b1 + 1];
        const mag1sq = re1 * re1 + im1 * im1;

        // Weighted average of magnitude-squared based on bin proximity, then sqrt
        // This avoids complex-domain interference while tracking the signal cleanly
        const frac = ch.binFrac;
        const mag = Math.sqrt(mag0sq * (1 - frac) + mag1sq * frac) / N;
        channelOutputs.get(key)[h] = mag;
      }
    }

    // Save overlap for next call — preserve ALL samples from the next hop start onward
    // so the next block can continue exactly where we left off
    const nextHopStart = numHops * hop;
    const remaining = totalSamples - nextHopStart;
    const actualOverlap = Math.min(remaining, this._maxOverlap);
    const srcStart = nextHopStart * 2;
    this._overlapBuf.set(workBuf.subarray(srcStart, srcStart + actualOverlap * 2));
    this._overlapValid = actualOverlap;

    return channelOutputs;
  }

  getChannels() {
    return Array.from(this._channels.keys());
  }

  clear() {
    this._channels.clear();
    this._overlapValid = 0;
  }

  get channelCount() { return this._channels.size; }
  get outputRate() { return this._actualOutputRate; }
  get binWidth() { return this._binWidth; }
}

module.exports = { StftChannelizer };
