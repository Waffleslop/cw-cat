// FFT wrapper using fft.js (pure JS radix-4 FFT)
// Provides windowed FFT on complex IQ data and magnitude spectrum output
const FFT = require('fft.js');

class FftProcessor {
  /**
   * @param {number} size - FFT size (must be power of 2)
   */
  constructor(size) {
    this._size = size;
    this._fft = new FFT(size);
    this._window = this._createBlackmanHarrisWindow(size);
    // Pre-allocate work arrays
    this._input = this._fft.createComplexArray();
    this._output = this._fft.createComplexArray();
    this._magnitudes = new Float32Array(size);
    // Spectral averaging buffer for improved SNR
    this._avgSpectrum = new Float32Array(size);
    this._avgInitialized = false;
    this._avgAlpha = 0.4; // Blend factor: 0.4 new + 0.6 old (mild averaging)
  }

  /**
   * Create a 4-term Blackman-Harris window.
   * Sidelobe level: -92 dB (vs Hann's -43 dB)
   * Main lobe width: ~8 bins (vs Hann's ~4 bins) — acceptable tradeoff
   * This dramatically improves adjacent-signal rejection on crowded CW bands.
   */
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
   * Compute windowed FFT on interleaved I/Q data.
   * @param {Float32Array} iqData - Interleaved I/Q samples (length = size * 2)
   * @returns {Float32Array} - Magnitude spectrum in dB (length = size), DC-centered (fftshift)
   */
  process(iqData) {
    const N = this._size;

    // Apply Hann window to complex input
    for (let i = 0; i < N; i++) {
      this._input[2 * i] = iqData[2 * i] * this._window[i];       // I (real)
      this._input[2 * i + 1] = iqData[2 * i + 1] * this._window[i]; // Q (imag)
    }

    // Forward FFT
    this._fft.transform(this._output, this._input);

    // Compute magnitude with fftshift (DC in center)
    // Use linear-domain averaging before converting to dB for better SNR
    const half = N / 2;
    for (let i = 0; i < N; i++) {
      const j = (i + half) % N;
      const re = this._output[2 * j];
      const im = this._output[2 * j + 1];
      const mag = Math.sqrt(re * re + im * im) / N;

      // Exponential moving average in linear domain (before dB conversion)
      // This improves SNR by ~3dB with alpha=0.4, at cost of slight time smearing
      if (!this._avgInitialized) {
        this._avgSpectrum[i] = mag;
      } else {
        this._avgSpectrum[i] = this._avgSpectrum[i] * (1 - this._avgAlpha) + mag * this._avgAlpha;
      }

      const avgMag = this._avgSpectrum[i];
      this._magnitudes[i] = avgMag > 1e-12 ? 20 * Math.log10(avgMag) : -240;
    }
    this._avgInitialized = true;

    return this._magnitudes;
  }

  /**
   * Get raw complex FFT output (not dB, not shifted).
   * @param {Float32Array} iqData
   * @returns {Float32Array} - Complex output array (length = size * 2)
   */
  processRaw(iqData) {
    const N = this._size;
    for (let i = 0; i < N; i++) {
      this._input[2 * i] = iqData[2 * i] * this._window[i];
      this._input[2 * i + 1] = iqData[2 * i + 1] * this._window[i];
    }
    this._fft.transform(this._output, this._input);
    return this._output;
  }

  get size() { return this._size; }
}

module.exports = { FftProcessor };
