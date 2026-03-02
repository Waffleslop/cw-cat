// Signal detector: finds CW signal peaks in FFT magnitude spectrum
// Uses noise floor estimation and persistence filtering

class SignalDetector {
  /**
   * @param {number} fftSize - Number of FFT bins
   * @param {number} sampleRate - Sample rate in Hz
   * @param {number} thresholdDb - Detection threshold in dB above noise floor
   */
  constructor(fftSize, sampleRate, thresholdDb) {
    this._fftSize = fftSize;
    this._sampleRate = sampleRate;
    this._thresholdDb = thresholdDb || 6;
    this._binWidth = sampleRate / fftSize; // Hz per bin

    // Noise floor estimation — dual-rate asymmetric tracking
    this._noiseFloor = new Float32Array(fftSize);
    this._noiseFloorInitialized = false;
    // Dual-rate: fast downward (2s τ), slow upward (20s τ)
    // Fast downward tracks band openings and noise drops quickly
    // Slow upward prevents signals from raising the floor
    this._noiseAlphaDown = 0.05;  // ~2s τ at 50fps — fast drop tracking
    this._noiseAlphaUp = 0.005;   // ~20s τ — very slow rise, resists signal contamination
    this._frameCount = 0;
    this._warmupFrames = 10; // Reduced from 20 — faster startup (200ms vs 400ms)

    // Persistence filter: count consecutive detections per bin
    this._persistence = new Uint16Array(fftSize);
    this._minPersistence = 5; // Require 5 consecutive frames (~100ms at 50fps)

    // Active signals: Map of bin index → signal info
    this._activeSignals = new Map();

    // Minimum spacing between detected signals (bins) — 200 Hz minimum
    this._minSpacing = Math.ceil(200 / this._binWidth);

    // Max signals to track simultaneously
    this._maxSignals = 80; // Match MAX_CHANNELS + headroom for signal tracking

    // Signal tracker: maintains identity of signals across frames
    // Each tracked signal has a smoothed frequency and SNR estimate
    this._trackedSignals = new Map(); // id → { bin, freqOffset, snr, magnitude, age, missCount }
    this._nextTrackId = 0;
    this._trackAssociationRadius = Math.ceil(150 / this._binWidth); // 150Hz association window
    this._maxMissCount = 10; // Drop track after 10 consecutive misses
  }

  setThreshold(db) {
    this._thresholdDb = db;
  }

  /**
   * Process one FFT magnitude frame and return detected signals.
   * @param {Float32Array} spectrum - Magnitude spectrum in dB (DC-centered, length=fftSize)
   * @returns {Array<{bin: number, freqOffset: number, magnitude: number, snr: number}>}
   */
  detect(spectrum) {
    const N = this._fftSize;
    this._frameCount++;

    // Update noise floor estimate
    this._updateNoiseFloor(spectrum);

    // Don't detect during warmup — let noise floor stabilize
    if (this._frameCount < this._warmupFrames) return [];

    // Find peaks above threshold
    const candidates = [];

    // Skip DC region (center ±5 bins) and edges
    const dcSkip = 5;
    const halfN = N / 2;

    for (let i = 3; i < N - 3; i++) {
      // Skip DC region
      if (Math.abs(i - halfN) < dcSkip) continue;

      const mag = spectrum[i];
      const noise = this._noiseFloor[i];
      const snr = mag - noise;

      if (snr >= this._thresholdDb) {
        // Strict local maximum: must be higher than ±3 neighbors
        if (mag > spectrum[i - 1] && mag > spectrum[i + 1] &&
            mag > spectrum[i - 2] && mag > spectrum[i + 2] &&
            mag > spectrum[i - 3] && mag > spectrum[i + 3]) {
          this._persistence[i] = Math.min(this._persistence[i] + 1, 1000);

          if (this._persistence[i] >= this._minPersistence) {
            // Parabolic interpolation for sub-bin frequency accuracy
            // Uses the three points around the peak to find the true maximum
            // This gives ~1Hz precision vs ~47Hz bin width
            const y1 = spectrum[i - 1];
            const y2 = mag;
            const y3 = spectrum[i + 1];
            const denom = y1 - 2 * y2 + y3;
            let fracBin = 0;
            let interpMag = mag;
            if (Math.abs(denom) > 1e-10) {
              fracBin = 0.5 * (y1 - y3) / denom; // -0.5 to +0.5 bin offset
              interpMag = y2 - 0.25 * (y1 - y3) * fracBin; // Interpolated peak magnitude
            }
            const preciseFreqOffset = (i + fracBin - halfN) * this._binWidth;

            candidates.push({
              bin: i,
              freqOffset: preciseFreqOffset,
              magnitude: interpMag,
              snr: interpMag - noise,
              persistence: this._persistence[i],
            });
          }
        } else {
          // Not a local max — decay persistence
          if (this._persistence[i] > 0) this._persistence[i]--;
        }
      } else {
        // Below threshold — decay persistence faster
        this._persistence[i] = Math.max(0, this._persistence[i] - 2);
      }
    }

    // Non-maximum suppression: keep only the strongest peak within minSpacing
    candidates.sort((a, b) => b.snr - a.snr);
    const signals = [];

    for (const c of candidates) {
      if (signals.length >= this._maxSignals) break;
      let tooClose = false;
      for (const s of signals) {
        if (Math.abs(c.bin - s.bin) < this._minSpacing) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) {
        signals.push(c);
      }
    }

    // Update tracked signals — associate detections with existing tracks
    this._updateTracks(signals);

    // Update active signals map
    this._activeSignals.clear();
    for (const sig of signals) {
      this._activeSignals.set(sig.bin, sig);
    }

    return signals;
  }

  /**
   * Update noise floor estimate.
   * Uses a slow EMA that only tracks when signal is near or below current estimate.
   * First few frames use a faster rate to converge.
   */
  _updateNoiseFloor(spectrum) {
    const N = this._fftSize;

    if (!this._noiseFloorInitialized) {
      // Initialize with first frame
      for (let i = 0; i < N; i++) {
        this._noiseFloor[i] = spectrum[i];
      }
      this._noiseFloorInitialized = true;
      return;
    }

    // During warmup, use fast alpha for quick convergence
    const isWarmup = this._frameCount < this._warmupFrames;
    const alphaDown = isWarmup ? 0.2 : this._noiseAlphaDown;
    const alphaUp = isWarmup ? 0.1 : this._noiseAlphaUp;

    for (let i = 0; i < N; i++) {
      const val = spectrum[i];
      if (val < this._noiseFloor[i]) {
        // Below current estimate — track down quickly (band openings, noise drops)
        this._noiseFloor[i] += (val - this._noiseFloor[i]) * alphaDown;
      } else if (val < this._noiseFloor[i] + this._thresholdDb * 0.4) {
        // Very close to noise floor (within 40% of threshold) — update slowly upward
        // Tightened from 0.75 to 0.4 to prevent adjacent strong signals from
        // raising the floor and desensitizing nearby weak signal detection
        this._noiseFloor[i] += (val - this._noiseFloor[i]) * alphaUp;
      }
      // Well above noise floor (signal present) — don't update
    }
  }

  /**
   * Update signal tracks — associate current detections with existing tracks.
   * Provides temporal continuity for signals that may flicker between frames.
   */
  _updateTracks(signals) {
    const used = new Set();

    // Try to associate each existing track with a current detection
    for (const [id, track] of this._trackedSignals) {
      let bestMatch = null;
      let bestDist = Infinity;

      for (let i = 0; i < signals.length; i++) {
        if (used.has(i)) continue;
        const dist = Math.abs(signals[i].bin - track.bin);
        if (dist < this._trackAssociationRadius && dist < bestDist) {
          bestDist = dist;
          bestMatch = i;
        }
      }

      if (bestMatch !== null) {
        // Update track with new detection (smooth frequency with EMA)
        const sig = signals[bestMatch];
        track.freqOffset = track.freqOffset * 0.7 + sig.freqOffset * 0.3;
        track.bin = sig.bin;
        track.snr = track.snr * 0.5 + sig.snr * 0.5;
        track.magnitude = sig.magnitude;
        track.age++;
        track.missCount = 0;
        track.persistence = sig.persistence;
        used.add(bestMatch);
      } else {
        // No matching detection — increment miss count
        track.missCount++;
        if (track.missCount > this._maxMissCount) {
          this._trackedSignals.delete(id);
        }
      }
    }

    // Create new tracks for unassociated detections
    for (let i = 0; i < signals.length; i++) {
      if (used.has(i)) continue;
      const sig = signals[i];
      this._trackedSignals.set(this._nextTrackId++, {
        bin: sig.bin,
        freqOffset: sig.freqOffset,
        snr: sig.snr,
        magnitude: sig.magnitude,
        age: 1,
        missCount: 0,
        persistence: sig.persistence,
      });
    }
  }

  /**
   * Get tracked signals (includes signals that may have briefly dropped).
   */
  getTrackedSignals() {
    return Array.from(this._trackedSignals.values());
  }

  getNoiseFloor() {
    return this._noiseFloor;
  }

  getActiveSignals() {
    return Array.from(this._activeSignals.values());
  }
}

module.exports = { SignalDetector };
