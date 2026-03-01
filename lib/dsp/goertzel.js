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

    // Rate-independent EMA: α = 1 - e^(-1/(rate*τ)) gives the same time constant
    // regardless of sample rate. Target time constants:
    //   smooth: 6ms (fast edge detection — reduced from 8ms for better timing resolution)
    //   avg: 100ms (diagnostic)
    //   peak: 1.5s (reduced from 3s — faster QSB recovery)
    //   noise: 2s (reduced from 3s — faster adaptation to changing conditions)
    this._smoothAlpha = 1 - Math.exp(-1 / (rate * 0.006)); // τ=6ms — sharper edges for better timing
    this._alpha = 1 - Math.exp(-1 / (rate * 0.1));          // τ=100ms
    this._peakAlpha = 1 - Math.exp(-1 / (rate * 1.5));      // τ=1.5s — faster QSB recovery (was 3s)
    this._noiseAlpha = 1 - Math.exp(-1 / (rate * 2.0));     // τ=2s — faster noise adaptation (was 3s)
    this._state = false;     // Current key state: true = key down
    this._threshold = 0;     // Adaptive threshold
    this._sampleCount = 0;
    this._warmup = true;
    this._warmupSamples = Math.max(8, Math.ceil(rate * 0.05));  // 50ms warmup (was 100ms)
    this._debounceCount = 0;
    this._debounceLimit = Math.max(1, Math.ceil(rate * 0.006)); // ~6ms debounce (was 8ms — tighter for fast CW)
    this._rawState = false;
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
      // This is the value we compare against thresholds
      this._smoothMag = this._smoothMag * (1 - this._smoothAlpha) + mag * this._smoothAlpha;

      // Update running average (diagnostic)
      this._avgMag = this._avgMag * (1 - this._alpha) + mag * this._alpha;

      // Track peak (fast rise, slow decay) — represents key-down level
      // Only decay toward smoothMag when key appears UP (below current threshold)
      if (this._smoothMag > this._peakMag) {
        this._peakMag = this._smoothMag;
      } else if (this._smoothMag < this._threshold) {
        // Key is up — decay peak slowly
        this._peakMag = this._peakMag * (1 - this._peakAlpha) + this._smoothMag * this._peakAlpha;
      }

      // Track noise floor (fast fall, slow rise) — represents key-up level
      // Only rise toward smoothMag when key appears UP (below current threshold)
      if (this._smoothMag < this._noiseMag) {
        this._noiseMag = this._smoothMag;
      } else if (this._smoothMag < this._threshold) {
        // Key is up — rise noise slowly toward actual noise level
        this._noiseMag = this._noiseMag * (1 - this._noiseAlpha) + this._smoothMag * this._noiseAlpha;
      }

      this._sampleCount++;

      // Skip transitions during warmup
      if (this._warmup) {
        if (this._sampleCount >= this._warmupSamples) {
          this._warmup = false;
        }
        continue;
      }

      // Adaptive threshold: midpoint between noise floor and peak
      this._threshold = (this._noiseMag + this._peakMag) / 2;

      // Need sufficient dynamic range to detect keying (at least 2.0:1)
      // Raised from 1.5 to reduce false transitions on marginal signals
      const dynamicRange = this._peakMag / (this._noiseMag + 1e-10);
      if (dynamicRange < 2.0) continue;

      // Adaptive hysteresis — narrower for strong signals (precise timing),
      // wider for weak signals (noise immunity)
      // Strong (DR>10): 60/40 — tight, precise edge detection
      // Weak (DR~3): 70/30 — wide, noise-resistant
      const drFactor = Math.min(1.0, Math.log10(dynamicRange) / 1.0); // 0..1 as DR goes 1..10
      const upperFrac = 0.70 - drFactor * 0.10; // 0.70 weak → 0.60 strong
      const lowerFrac = 0.30 + drFactor * 0.10; // 0.30 weak → 0.40 strong
      const upperThresh = this._noiseMag + (this._peakMag - this._noiseMag) * upperFrac;
      const lowerThresh = this._noiseMag + (this._peakMag - this._noiseMag) * lowerFrac;

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
    this._noiseMag = 0;
    this._state = false;
    this._rawState = false;
    this._debounceCount = 0;
    this._threshold = 0;
    this._sampleCount = 0;
    this._warmup = true;
  }
}

module.exports = { goertzel, CwEnvelopeDetector };
