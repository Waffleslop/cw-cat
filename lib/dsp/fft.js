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
    this._window = this._createHannWindow(size);
    // Pre-allocate work arrays
    this._input = this._fft.createComplexArray();
    this._output = this._fft.createComplexArray();
    this._magnitudes = new Float32Array(size);
  }

  /**
   * Create a Hann window of given size.
   */
  _createHannWindow(N) {
    const w = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
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

    // Compute magnitude in dB with fftshift (DC in center)
    const half = N / 2;
    for (let i = 0; i < N; i++) {
      // fftshift: swap first half and second half
      const j = (i + half) % N;
      const re = this._output[2 * j];
      const im = this._output[2 * j + 1];
      const mag = Math.sqrt(re * re + im * im) / N;
      this._magnitudes[i] = mag > 1e-12 ? 20 * Math.log10(mag) : -240;
    }

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
