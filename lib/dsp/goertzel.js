// Goertzel tone detector for CW on/off keying detection
// More efficient than FFT when detecting a single frequency

/**
 * Single-frequency magnitude detector using the Goertzel algorithm.
 * @param {Float32Array} samples - Input samples
 * @param {number} targetFreq - Target frequency in Hz
 * @param {number} sampleRate - Sample rate in Hz
 * @returns {number} - Magnitude at the target frequency
 */
function goertzel(samples, targetFreq, sampleRate) {
  const N = samples.length;
  const k = Math.round((N * targetFreq) / sampleRate);
  const w = (2 * Math.PI * k) / N;
  const coeff = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / N;
}

/**
 * CW envelope detector: converts raw magnitude samples into on/off keying state.
 * Uses adaptive threshold with hysteresis for robust detection.
 */
class CwEnvelopeDetector {
  /**
   * @param {number} rate - Expected input sample rate in Hz (default 94 for FFT-bin mode)
   */
  constructor(rate) {
    rate = rate || 94;
    this._rate = rate;

    this._smoothMag = 0;     // Smoothed magnitude (for threshold comparison)
    this._avgMag = 0;        // Running average of magnitude (diagnostic)
    this._peakMag = 0;       // Running peak magnitude
    this._noiseMag = 0;      // Running estimate of noise floor (min tracker)

    // Rate-independent EMA: α = 1 - e^(-1/(rate*τ))
    this._smoothAlpha = 1 - Math.exp(-1 / (rate * 0.006)); // τ=6ms — sharp edges
    this._alpha = 1 - Math.exp(-1 / (rate * 0.1));          // τ=100ms
    this._peakAlphaFast = 1 - Math.exp(-1 / (rate * 0.8)); // τ=0.8s — fast peak recovery
    this._peakAlphaSlow = 1 - Math.exp(-1 / (rate * 5.0)); // τ=5s — slow peak memory (QSB resistant)
    this._noiseAlpha = 1 - Math.exp(-1 / (rate * 2.0));     // τ=2s — noise adaptation
    this._peakHold = 0; // Held peak for QSB resistance (decays slowly)
    this._state = false;
    this._threshold = 0;
    this._sampleCount = 0;
    this._warmup = true;
    this._warmupSamples = Math.max(8, Math.ceil(rate * 0.05));  // 50ms warmup
    this._debounceCount = 0;
    this._debounceLimit = Math.max(1, Math.ceil(rate * 0.006)); // ~6ms debounce
    this._rawState = false;

    // Moving-minimum noise estimator: track the minimum over a sliding window
    // More robust than EMA for noise floor — immune to signal peaks
    // Window = 200ms worth of samples (captures inter-element gaps)
    this._minWindowSize = Math.max(8, Math.ceil(rate * 0.2));
    this._minWindow = new Float32Array(this._minWindowSize);
    this._minWindowPos = 0;
    this._minWindowFilled = false;
  }

  /**
   * Process a block of envelope magnitude samples.
   * @param {Float32Array} magnitudes - Envelope magnitudes from channelizer
   * @param {number} sampleRate - Output sample rate of the channelizer
   * @returns {Array<{state: boolean, time: number}>} - State transitions with timestamps
   */
  process(magnitudes, sampleRate) {
    const transitions = [];

    for (let i = 0; i < magnitudes.length; i++) {
      const mag = magnitudes[i];

      // Initialize on first sample
      if (this._sampleCount === 0) {
        this._smoothMag = mag;
        this._avgMag = mag;
        this._peakMag = mag;
        this._noiseMag = mag;
      }

      // Smooth the raw magnitude to suppress sample-to-sample noise
      this._smoothMag = this._smoothMag * (1 - this._smoothAlpha) + mag * this._smoothAlpha;

      // Update running average (diagnostic)
      this._avgMag = this._avgMag * (1 - this._alpha) + mag * this._alpha;

      // Moving-minimum window: feed smoothed magnitude
      // This provides a robust noise floor estimate immune to signal peaks
      this._minWindow[this._minWindowPos] = this._smoothMag;
      this._minWindowPos = (this._minWindowPos + 1) % this._minWindowSize;
      if (!this._minWindowFilled && this._minWindowPos === 0) {
        this._minWindowFilled = true;
      }

      // Compute window minimum for noise estimation
      // Only scan window when we have enough data
      if (this._minWindowFilled || this._minWindowPos >= 8) {
        const len = this._minWindowFilled ? this._minWindowSize : this._minWindowPos;
        let windowMin = Infinity;
        for (let k = 0; k < len; k++) {
          if (this._minWindow[k] < windowMin) windowMin = this._minWindow[k];
        }
        // Blend window minimum with EMA noise estimate for stability
        // Window minimum is fast-reacting, EMA is smooth
        const targetNoise = windowMin;
        if (targetNoise < this._noiseMag) {
          this._noiseMag = targetNoise; // Fast drop
        } else if (this._smoothMag < this._threshold || this._threshold === 0) {
          this._noiseMag = this._noiseMag * (1 - this._noiseAlpha) + targetNoise * this._noiseAlpha;
        }
      } else {
        // During initial fill, use simple EMA
        if (this._smoothMag < this._noiseMag) {
          this._noiseMag = this._smoothMag;
        } else {
          this._noiseMag = this._noiseMag * (1 - this._noiseAlpha) + this._smoothMag * this._noiseAlpha;
        }
      }

      // Dual-rate peak tracking: fast peak for threshold, slow hold for QSB memory
      // The fast peak responds to normal CW keying (rises instantly, decays in ~0.8s)
      // The slow hold remembers the signal level through QSB fades (~5s memory)
      // The effective peak used for thresholding is the max of both
      if (this._smoothMag > this._peakMag) {
        this._peakMag = this._smoothMag;
      } else if (this._smoothMag < this._threshold) {
        this._peakMag = this._peakMag * (1 - this._peakAlphaFast) + this._smoothMag * this._peakAlphaFast;
      }
      // Slow hold: remembers signal peak through deep QSB fades
      if (this._smoothMag > this._peakHold) {
        this._peakHold = this._smoothMag;
      } else {
        this._peakHold = this._peakHold * (1 - this._peakAlphaSlow) + this._smoothMag * this._peakAlphaSlow;
      }
      // Use whichever peak is higher — prevents threshold collapse during QSB
      const effectivePeak = Math.max(this._peakMag, this._peakHold * 0.7);

      this._sampleCount++;

      // Skip transitions during warmup
      if (this._warmup) {
        if (this._sampleCount >= this._warmupSamples) {
          this._warmup = false;
        }
        continue;
      }

      // Adaptive threshold using effective peak (QSB-resistant)
      this._threshold = (this._noiseMag + effectivePeak) / 2;

      // Need sufficient dynamic range to detect keying
      const dynamicRange = effectivePeak / (this._noiseMag + 1e-10);
      if (dynamicRange < 2.0) continue;

      // Adaptive hysteresis — narrower for strong signals (precise timing),
      // wider for weak signals (noise immunity)
      const drFactor = Math.min(1.0, Math.log10(dynamicRange) / 1.0);
      const upperFrac = 0.70 - drFactor * 0.10;
      const lowerFrac = 0.30 + drFactor * 0.10;
      const upperThresh = this._noiseMag + (effectivePeak - this._noiseMag) * upperFrac;
      const lowerThresh = this._noiseMag + (effectivePeak - this._noiseMag) * lowerFrac;

      // Compute raw (pre-debounce) state
      let newRawState = this._rawState;
      if (!this._rawState && this._smoothMag > upperThresh) {
        newRawState = true;
      } else if (this._rawState && this._smoothMag < lowerThresh) {
        newRawState = false;
      }

      // Debounce: only emit transition after state is stable for _debounceLimit samples
      if (newRawState !== this._rawState) {
        this._rawState = newRawState;
        this._debounceCount = 0;
      } else if (this._rawState !== this._state) {
        this._debounceCount++;
        if (this._debounceCount >= this._debounceLimit) {
          this._state = this._rawState;
          transitions.push({
            state: this._state,
            time: this._sampleCount / sampleRate,
            sample: this._sampleCount,
          });
        }
      }
    }

    return transitions;
  }

  /**
   * Get current key state.
   */
  get keyDown() { return this._state; }

  /**
   * Reset detector state.
   */
  reset() {
    this._smoothMag = 0;
    this._avgMag = 0;
    this._peakMag = 0;
    this._peakHold = 0;
    this._noiseMag = 0;
    this._state = false;
    this._rawState = false;
    this._debounceCount = 0;
    this._threshold = 0;
    this._sampleCount = 0;
    this._warmup = true;
    this._minWindow.fill(0);
    this._minWindowPos = 0;
    this._minWindowFilled = false;
  }
}

module.exports = { goertzel, CwEnvelopeDetector };
