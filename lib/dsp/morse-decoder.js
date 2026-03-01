// Morse code decoder state machine
// Measures on/off element durations, estimates speed, decodes characters

// International Morse Code lookup table
const MORSE_TABLE = {
  '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E',
  '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J',
  '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N', '---': 'O',
  '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T',
  '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y',
  '--..': 'Z',
  '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4',
  '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9',
  '.-.-.-': '.', '--..--': ',', '..--..': '?', '.----.': "'",
  '-.-.--': '!', '-..-.': '/', '-.--.': '(', '-.--.-': ')',
  '.-...': '&', '---...': ':', '-.-.-.': ';', '-...-': '=',
  '.-.-.': '+', '-....-': '-', '..--.-': '_', '.-..-.': '"',
  '...-..-': '$', '.--.-.': '@',
  // Prosigns
  '-.-.-': '<KA>', '...-.-': '<SK>', '-...-': '<BT>', '.-.-': '<AR>',
};

class MorseDecoder {
  /**
   * @param {number} minWpm - Minimum WPM to detect (default 8)
   * @param {number} maxWpm - Maximum WPM to detect (default 60)
   */
  constructor(minWpm, maxWpm) {
    this._minWpm = minWpm || 8;
    this._maxWpm = maxWpm || 60;

    // Timing state
    this._ditDuration = 0.08; // Initial estimate: ~15 WPM (80ms dit)
    this._elements = [];       // Current character elements: '.' and '-'
    this._decodedText = '';
    this._currentChar = '';

    // Timing history for adaptive speed estimation
    this._onDurations = [];  // Recent key-down durations
    this._offDurations = []; // Recent key-up durations
    this._maxHistory = 40;

    // State
    this._lastTransitionTime = 0;
    this._lastState = false;
    this._started = false;
    this._charTimeout = null;
    this._wordTimeout = null;
    this._wpm = 15; // Initial estimate
    this._speedLocked = false; // Set when speed estimator converges
    this._dahDitRatio = 3.0; // Measured dah/dit ratio (default standard 3:1)

    // Callbacks
    this._onChar = null;
    this._onWord = null;
    this._onText = null;
  }

  /**
   * Set WPM range filter.
   */
  setWpmRange(min, max) {
    this._minWpm = min || 8;
    this._maxWpm = max || 60;
  }

  /**
   * Feed state transitions from the envelope detector.
   * @param {Array<{state: boolean, time: number}>} transitions
   */
  feedTransitions(transitions) {
    for (const { state, time } of transitions) {
      if (!this._started) {
        this._started = true;
        this._lastTransitionTime = time;
        this._lastState = state;
        continue;
      }

      const duration = time - this._lastTransitionTime;

      if (this._lastState) {
        // Key was DOWN — this is an on-element duration
        this._processOnDuration(duration);
      } else {
        // Key was UP — this is a gap duration
        this._processOffDuration(duration);
      }

      this._lastTransitionTime = time;
      this._lastState = state;
    }
  }

  /**
   * Process a key-down duration — classify as dit or dah.
   */
  _processOnDuration(duration) {
    // Filter out impossibly short elements (noise spikes)
    // At 60 WPM, a dit = 20ms. Reject anything under 15ms.
    if (duration < 0.015) return;

    // Filter out impossibly long elements (stuck key or noise)
    // At 8 WPM, a dah = 450ms. Reject anything over 600ms.
    if (duration > 0.6) return;

    // Only add to speed history if duration is plausible for current speed
    // This prevents noise-burst contamination when DR drops briefly
    const minPlausible = this._ditDuration * 0.5; // 50% of expected dit
    const maxPlausible = this._ditDuration * 5.0;  // 167% of expected dah
    if (duration >= minPlausible && duration <= maxPlausible) {
      this._onDurations.push(duration);
      if (this._onDurations.length > this._maxHistory) {
        this._onDurations.shift();
      }
      // Update speed estimate
      this._updateSpeedEstimate();
    }

    // Classify element — use geometric mean of measured dah/dit ratio
    // For standard 3:1 ratio, threshold = sqrt(3) ≈ 1.73x dit
    // For tight 2:1 senders, threshold = sqrt(2) ≈ 1.41x dit
    // This adapts to each operator's actual sending style
    const threshold = this._ditDuration * Math.sqrt(this._dahDitRatio);
    if (duration < threshold) {
      this._elements.push('.');
    } else {
      this._elements.push('-');
    }

    // Safety valve: longest valid Morse character is 7 elements (prosigns like <BK>)
    // If we've accumulated more than 8, the gap detector isn't firing — force flush
    if (this._elements.length > 8) {
      this._finalizeCharacter();
    }
  }

  /**
   * Process a key-up duration — classify as intra-char, inter-char, or word gap.
   */
  _processOffDuration(duration) {
    // Filter out impossibly short gaps (noise)
    if (duration < 0.015) return;

    this._offDurations.push(duration);
    if (this._offDurations.length > this._maxHistory) {
      this._offDurations.shift();
    }

    // Classify gap
    // Standard Morse: intra-char = 1 dit, char gap = 3 dit, word gap = 7 dit
    // Geometric mean of intra-char and char gap: sqrt(1*3) ≈ 1.73x
    // Use 2.2x as compromise — handles slightly loose intra-char timing
    // while catching most inter-char gaps (operators typically send >= 2.5x)
    const charGapThreshold = this._ditDuration * 2.2;  // > 2.2 dit = character boundary
    const wordGapThreshold = this._ditDuration * 4.0;  // > 4.0 dit = word boundary

    if (duration >= wordGapThreshold) {
      // Word gap — finalize character, then add space
      this._finalizeCharacter();
      if (this._speedLocked) {
        this._decodedText += ' ';
        if (this._onWord) this._onWord(' ');
      }
    } else if (duration >= charGapThreshold) {
      // Character gap — finalize character
      this._finalizeCharacter();
    }
    // Else: intra-character gap — do nothing, elements continue accumulating
  }

  /**
   * Finalize the current character from accumulated elements.
   */
  _finalizeCharacter() {
    if (this._elements.length === 0) return;

    // Don't emit characters until speed estimator has locked on
    // This prevents garbage E/I/S/T output from noise before we know the real speed
    if (!this._speedLocked) {
      this._elements = [];
      return;
    }

    const morse = this._elements.join('');
    const char = MORSE_TABLE[morse] || '\u00BF'; // ¿ for unknown
    this._elements = [];

    this._decodedText += char;
    if (this._onChar) this._onChar(char);
    if (this._onText) this._onText(this._decodedText);
  }

  /**
   * Force flush of any pending elements (e.g., at end of transmission).
   */
  flush() {
    this._finalizeCharacter();
  }

  /**
   * Update speed estimate from recent element durations.
   * Uses bimodal clustering: dits and dahs form two clusters.
   */
  _updateSpeedEstimate() {
    if (this._onDurations.length < 4) return;

    // Simple approach: find the cluster boundary using sorted durations
    const sorted = [...this._onDurations].sort((a, b) => a - b);

    // Find the largest gap in sorted durations — separates dits from dahs
    let maxGap = 0;
    let gapIdx = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] / sorted[i - 1]; // Use ratio instead of absolute gap
      if (gap > maxGap) {
        maxGap = gap;
        gapIdx = i;
      }
    }

    // Require: gap must be at least 1.5x ratio, and both clusters need elements
    // The plausibility gate (0.5x-5.0x dit) already prevents noise from entering history
    if (maxGap < 1.5) return;
    if (gapIdx < 1 || (sorted.length - gapIdx) < 1) return;

    // For significant speed changes, require stronger evidence
    const ditClusterSize = gapIdx;
    const dahClusterSize = sorted.length - gapIdx;
    const prelimEstDit = sorted[Math.floor(ditClusterSize / 2)];
    const speedChangeRatio = prelimEstDit / this._ditDuration;
    if (this._speedLocked && (speedChangeRatio > 1.15 || speedChangeRatio < 0.85)) {
      // Big speed change — need at least 3 in each cluster
      if (ditClusterSize < 3 || dahClusterSize < 2) return;
    }

    // Median of the lower cluster = dit duration estimate (more robust than mean)
    const ditCluster = sorted.slice(0, gapIdx);
    const estDit = ditCluster[Math.floor(ditCluster.length / 2)];

    // Validate: dah cluster should average ~3x the dit estimate
    let dahSum = 0;
    for (let i = gapIdx; i < sorted.length; i++) dahSum += sorted[i];
    const estDah = dahSum / (sorted.length - gapIdx);
    const dahDitRatio = estDah / estDit;

    // Accept if dah/dit ratio is between 1.5 and 5.0 (standard is 3.0)
    // Some operators send shorter dahs, especially at slower speeds
    if (dahDitRatio < 1.5 || dahDitRatio > 5.0) return;

    // Require consistent dit cluster (CV < 0.4) — real CW has consistent element timing
    // Noise produces random durations with high variance
    if (ditCluster.length >= 3) {
      let ditSum = 0, ditSumSq = 0;
      for (const d of ditCluster) { ditSum += d; ditSumSq += d * d; }
      const ditMean = ditSum / ditCluster.length;
      const ditVar = ditSumSq / ditCluster.length - ditMean * ditMean;
      const ditCV = Math.sqrt(Math.max(0, ditVar)) / ditMean;
      if (ditCV > 0.4) return; // Too much variation — likely noise, not CW
    }

    // Sanity check against WPM limits
    // WPM = 1.2 / ditDuration (PARIS standard)
    const estWpm = 1.2 / estDit;
    if (estWpm >= this._minWpm && estWpm <= this._maxWpm) {
      // Three-tier adaptation rate:
      // First 10 elements: fast lock-on (50/50)
      // 10-20 elements: moderate adaptation (80/20)
      // 20+ elements: slow fine-tuning (90/10) — resists drift
      const nHist = this._onDurations.length;
      const alpha = nHist < 10 ? 0.5 : nHist < 20 ? 0.2 : 0.1;

      // Clamp speed change to max 25% per update to prevent runaway drift
      const newDit = this._ditDuration * (1 - alpha) + estDit * alpha;
      const ratio = newDit / this._ditDuration;
      if (ratio > 1.25) {
        this._ditDuration *= 1.25;
      } else if (ratio < 0.75) {
        this._ditDuration *= 0.75;
      } else {
        this._ditDuration = newDit;
      }
      this._wpm = 1.2 / this._ditDuration;
      this._dahDitRatio = dahDitRatio;
      this._speedLocked = true;
    }
  }

  /**
   * Check if this decoder has timed out (long silence = transmission ended).
   * @param {number} currentTime - Current time in seconds
   * @returns {boolean}
   */
  isTimedOut(currentTime) {
    if (!this._started) return false;
    // Timeout after 10 dit-lengths of silence
    return (currentTime - this._lastTransitionTime) > (this._ditDuration * 10);
  }

  /**
   * Get the current decoded text.
   */
  get text() { return this._decodedText; }

  /**
   * Get current estimated WPM.
   */
  get wpm() { return Math.round(this._wpm); }

  /**
   * Set event callbacks.
   */
  onChar(cb) { this._onChar = cb; }
  onWord(cb) { this._onWord = cb; }
  onText(cb) { this._onText = cb; }

  /**
   * Reset decoder state for a new transmission.
   * Preserves speed estimate (ditDuration, wpm, timing history) so the next
   * transmission starts with the correct speed rather than re-adapting.
   */
  reset() {
    this._elements = [];
    this._decodedText = '';
    // Keep _onDurations, _offDurations, _ditDuration, _wpm, _speedLocked — speed persists
    this._lastTransitionTime = 0;
    this._lastState = false;
    this._started = false;
  }
}

module.exports = { MorseDecoder, MORSE_TABLE };
