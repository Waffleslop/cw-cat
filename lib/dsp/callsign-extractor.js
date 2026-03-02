// Callsign extractor: finds amateur radio callsigns in decoded Morse text
// Looks for CQ/DE patterns and validates callsign format

// Standard amateur callsign pattern:
// 1-3 chars prefix (letter/digit), at least one digit, 1-4 letter suffix
// Optional portable suffix: /P, /M, /4, /ME, /QRP, etc.
// Examples: W1AW, KA1ABC, VE3NEA, 4X1RF, 3DA0RN, K2SX/ME, W1AW/4
// Note: suffix is [A-Z] only (not [A-Z0-9]) — real suffixes never contain digits
// This prevents false matches from concatenated callsigns like "K8ACK8AC"
const CALLSIGN_RE = /\b([A-Z0-9]{1,3}[0-9][A-Z]{1,4}(?:\/[A-Z0-9]{1,4})?)\b/g;

// Callsign sub-pattern (with optional portable suffix like /P, /4, /ME)
const CALL_PAT = '([A-Z0-9]{1,3}[0-9][A-Z]{1,4}(?:\\/[A-Z0-9]{1,4})?)';

// CQ calling patterns
const CQ_PATTERNS = [
  // "CQ CQ CQ DE W1AW W1AW K" or "CQ CQ DE K2SX/ME"
  new RegExp('CQ\\s+(?:CQ\\s+)*(?:DX\\s+)?DE\\s+' + CALL_PAT),
  // "CQ CQ W1AW W1AW"
  new RegExp('CQ\\s+(?:CQ\\s+)*(?:DX\\s+)?' + CALL_PAT),
  // "DE W1AW" or "DE W1AW/4"
  new RegExp('DE\\s+' + CALL_PAT),
  // "TEST W1AW" or "TEST DE W1AW"
  new RegExp('TEST\\s+(?:DE\\s+)?' + CALL_PAT),
  // Concatenated CQ (common decode artifact): "CQDEWB8ZUR" or "CQCQDEW1AW"
  new RegExp('CQ(?:CQ)*DE' + CALL_PAT),
  // Concatenated DE (no space): "DEKE9BHN" or "DEW1AW"
  new RegExp('DE' + CALL_PAT),
  // Garbled TEST: "NST" "EST" "IEST" "TIST" followed by callsign (common T→N/I misdecodings)
  new RegExp('[NEIT]ST\\s+' + CALL_PAT),
  // Contest CQ: "CQ NCQP W8FN" or "CQ POTA KE9BHN" — CQ + contest/activity name + callsign
  new RegExp('CQ\\s+[A-Z]{2,6}\\s+' + CALL_PAT),
  // Concatenated contest CQ: "CQNCQPNC4KW" — CQ + junk + callsign (no spaces)
  new RegExp('CQ[A-Z]{2,6}' + CALL_PAT),
];

class CallsignExtractor {
  /**
   * @param {object} ctyDb - Optional cty.dat database for DXCC validation
   * @param {Function} resolveCallsign - Optional function to validate against cty.dat
   */
  constructor(ctyDb, resolveCallsign) {
    this._ctyDb = ctyDb;
    this._resolveCallsign = resolveCallsign;
    // Dedup map: callsign → last spot timestamp (ms)
    this._recentSpots = new Map();
    this._dedupWindowMs = 120000; // 120 seconds — longer window catches garbled re-spots
  }

  /**
   * Extract callsigns from decoded Morse text.
   * @param {string} text - Decoded text (uppercase)
   * @param {number} [snr] - Optional signal SNR for confidence-weighted extraction
   * @returns {Array<{callsign: string, type: string}>}
   */
  extract(text, snr) {
    const upper = text.toUpperCase();
    const results = [];
    const seen = new Set();

    // SNR-aware occurrence threshold: weak signals need more repetitions
    // Minimum 2 occurrences always — single occurrence too prone to garbled callsigns
    // matching valid foreign prefixes (e.g., garbled "W4MGT" → "T4MT" matches Cuba)
    const minOccurrences = (snr !== undefined && snr < 15) ? 3 : 2;

    // Try structured patterns first (CQ, DE, TEST)
    for (const pattern of CQ_PATTERNS) {
      const m = upper.match(pattern);
      if (m && m[1]) {
        const call = m[1];
        if (!seen.has(call) && this._isValidCallsign(call) && !this._isFalsePositive(call)) {
          const callCount = this._countCallsignOccurrences(upper, call);
          if (callCount < minOccurrences) continue;

          // Reject concatenated-callsign artifacts: if the callsign never appears
          // as a standalone word (space/start/end bounded), it's likely embedded
          // in a repeated callsign like "K8ACK8ACK8AC" → false "FK8ACK"
          // Also catches "WB8ZURWB8ZUR" → false "B8ZURW" (callCount=2 but standalone=0)
          const standaloneCount = this._countStandaloneOccurrences(upper, call);
          if (standaloneCount === 0) continue;

          if (call.includes('/')) {
            const base = call.split('/')[0];
            const baseCount = this._countCallsignOccurrences(upper, base);
            if (baseCount < minOccurrences) continue;
          }

          let type = 'CQ';
          if (upper.includes('TEST')) type = 'TEST';
          else if (upper.includes('DX')) type = 'CQ DX';
          results.push({ callsign: call, type });
          seen.add(call);
        }
      }
    }

    // QSO extraction: look for answer patterns like "<call1> <call2> <RST>"
    // This catches stations in QSOs, not just callers
    // Requires higher evidence threshold since QSO patterns are more prone to false positives
    if (results.length === 0) {
      // QSO extraction needs cleaner text — check that text isn't mostly garbage
      const cleanChars = upper.replace(/[\s¿EIST]/g, '').length;
      const totalChars = upper.replace(/[\s]/g, '').length;
      const garbageRatio = totalChars > 0 ? 1 - (cleanChars / totalChars) : 1;

      // Only attempt QSO extraction if text has meaningful content (< 70% garbage)
      if (garbageRatio < 0.70) {
        const qsoPatterns = [
          // "W1AW DE K2SX" — answering a CQ
          new RegExp(CALL_PAT + '\\s+DE\\s+' + CALL_PAT),
          // "W1AW K2SX 599" — exchange (callsign followed by callsign then report)
          new RegExp(CALL_PAT + '\\s+' + CALL_PAT + '\\s+5[1-9N][1-9N]'),
          // "73 DE W1AW" or "73 DE K2SX/4" — sign-off with callsign
          new RegExp('73\\s+DE\\s+' + CALL_PAT),
          // "TU W1AW" or "TU DE W1AW" — thank you + callsign
          new RegExp('TU\\s+(?:DE\\s+)?' + CALL_PAT),
          // "K DE W1AW" — turning it over with callsign
          new RegExp('K\\s+DE\\s+' + CALL_PAT),
        ];
        // QSO spots need higher occurrence count to be confident
        const qsoMinOccurrences = Math.max(minOccurrences, 2);
        for (const pattern of qsoPatterns) {
          const m = upper.match(pattern);
          if (m) {
            // Both callsigns in a QSO are valid spots
            for (let gi = 1; gi <= 2 && gi < m.length; gi++) {
              const call = m[gi];
              if (call && !seen.has(call) && this._isValidCallsign(call) && !this._isFalsePositive(call)) {
                const callCount = this._countCallsignOccurrences(upper, call);
                if (callCount >= qsoMinOccurrences) {
                  results.push({ callsign: call, type: 'QSO' });
                  seen.add(call);
                }
              }
            }
          }
        }
      }
    }

    // Fallback: callsigns repeated standalone (no CQ/DE context)
    // This catches stations like "WA2VUY WA2VUY WA2VUY" without CQ/DE keywords
    if (results.length === 0) {
      let match;
      const standaloneRe = /(?:^|[\s])([A-Z0-9]{1,3}[0-9][A-Z]{1,4}(?:\/[A-Z0-9]{1,4})?)\b/g;
      while ((match = standaloneRe.exec(upper)) !== null) {
        const call = match[1];
        if (!seen.has(call) && this._isValidCallsign(call) && !this._isFalsePositive(call)) {
          const callCount = this._countStandaloneOccurrences(upper, call);
          // Check if this callsign is repeated back-to-back or dominates the text
          // "W8MK W8MK W8MK" → 3 standalone, clearly intentional
          const totalCallChars = callCount * call.length;
          const textLen = upper.replace(/\s/g, '').length;
          const dominatesText = textLen > 0 && totalCallChars / textLen > 0.4;
          // 3x for strong signals or dominant callsign, 4x otherwise
          const standaloneMin = (snr !== undefined && snr >= 20) || dominatesText ? 3 : 4;
          if (callCount >= standaloneMin) {
            results.push({ callsign: call, type: 'CQ' });
            seen.add(call);
          }
        }
      }
    }

    return results;
  }

  /**
   * Extract and dedup: returns only callsigns not spotted recently.
   * Uses both exact match and edit-distance check to prevent near-duplicates
   * like WA3MIX/WA3MID (1 character garble).
   * @param {string} text
   * @param {number} [snr] - Optional signal SNR
   * @returns {Array<{callsign: string, type: string}>}
   */
  extractNew(text, snr) {
    const all = this.extract(text, snr);
    const now = Date.now();
    const fresh = [];

    // Clean old entries
    for (const [call, ts] of this._recentSpots) {
      if (now - ts > this._dedupWindowMs) {
        this._recentSpots.delete(call);
      }
    }

    for (const result of all) {
      const lastSeen = this._recentSpots.get(result.callsign);
      if (lastSeen && (now - lastSeen) < this._dedupWindowMs) continue;

      // Check edit distance against all recent spots — prevents near-duplicates
      // like WA3MIX/WA3MID from both being spotted (common 1-char garble)
      const baseCall = result.callsign.split('/')[0];
      let tooSimilar = false;
      for (const [recentCall, ts] of this._recentSpots) {
        if (now - ts >= this._dedupWindowMs) continue;
        const recentBase = recentCall.split('/')[0];
        if (baseCall.length >= 4 && recentBase.length >= 4 &&
            Math.abs(baseCall.length - recentBase.length) <= 1 &&
            this._editDistance(baseCall, recentBase) <= 1) {
          tooSimilar = true;
          break;
        }
      }
      if (tooSimilar) continue;

      fresh.push(result);
      this._recentSpots.set(result.callsign, now);
    }

    return fresh;
  }

  /**
   * Compute Levenshtein edit distance between two strings.
   * Optimized for short strings (callsigns are 4-8 chars).
   */
  _editDistance(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // Single-row DP for space efficiency
    const row = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) row[j] = j;

    for (let i = 1; i <= a.length; i++) {
      let prev = i - 1;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        const val = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
        prev = row[j];
        row[j] = val;
      }
    }
    return row[b.length];
  }

  /**
   * Validate a callsign string.
   */
  _isValidCallsign(call) {
    // Strip portable suffix for validation (e.g., K2SX/ME → K2SX)
    const parts = call.split('/');
    const baseCall = parts[0];
    const suffix = parts[1] || '';

    // Validate portable suffix if present
    if (suffix) {
      // Valid suffixes: single digit (W1AW/4), 1-2 letter region (K2SX/ME),
      // or standard indicators (P, M, MM, QRP, AM)
      const validSuffixes = /^([0-9]|[A-Z]{1,2}|QRP|AM)$/;
      if (!validSuffixes.test(suffix)) return false;
    }

    // Must have at least 4 characters (shortest valid: W1AW)
    if (baseCall.length < 4) return false;
    if (baseCall.length > 8) return false;

    // Must contain at least one digit and one letter
    if (!/[0-9]/.test(baseCall)) return false;
    if (!/[A-Z]/.test(baseCall)) return false;

    // Must end with a letter
    if (!/[A-Z]$/.test(baseCall)) return false;

    // Find the district digit: the last digit followed by letter(s)
    // Handles 4X1RF (digit=1), 3DA0RN (digit=0), W1AW (digit=1)
    let distIdx = -1;
    for (let i = baseCall.length - 2; i >= 0; i--) {
      if (/[0-9]/.test(baseCall[i]) && /[A-Z]/.test(baseCall[i + 1])) {
        distIdx = i;
        break;
      }
    }
    if (distIdx < 0) return false;

    // Prefix (before district digit) must contain at least one letter
    const prefixPart = baseCall.substring(0, distIdx);
    if (prefixPart.length === 0 || !/[A-Z]/.test(prefixPart)) return false;

    // Suffix (after district digit) must be 1-4 letters only
    const suffixPart = baseCall.substring(distIdx + 1);
    if (suffixPart.length === 0 || suffixPart.length > 4) return false;
    if (!/^[A-Z]+$/.test(suffixPart)) return false;

    // Validate against cty.dat if available (use base callsign)
    if (this._resolveCallsign && this._ctyDb) {
      const entity = this._resolveCallsign(baseCall, this._ctyDb);
      if (!entity) return false;
    }

    return true;
  }

  /**
   * Count occurrences of a callsign in text.
   * Uses fuzzy matching to catch common CW garbling:
   * - Suffix garble: "EA1W" matches "EA1WH" (trailing char garbled)
   * - Prefix garble: "A2HZO" matches "WA2HZO" (leading char garbled)
   * - Core match: the digit+suffix portion (e.g., "2HZO") is highly distinctive
   */
  _countCallsignOccurrences(text, callsign) {
    // Use base callsign (strip portable suffix) for occurrence counting
    const baseCall = callsign.includes('/') ? callsign.split('/')[0] : callsign;
    let count = 0;
    let pos = 0;

    // Primary: match prefix (all but last char) to catch trailing garble
    const searchStr = baseCall.length >= 5 ? baseCall.slice(0, -1) : baseCall;
    while ((pos = text.indexOf(searchStr, pos)) !== -1) {
      count++;
      pos += searchStr.length;
    }

    // Secondary: also check for core match (digit + suffix) to catch prefix garble
    // E.g., for "WA2HZO", search for "2HZO" — this is the most distinctive part
    if (count < 2 && baseCall.length >= 5) {
      const distIdx = baseCall.search(/[0-9][A-Z]+$/);
      if (distIdx >= 1) {
        const core = baseCall.slice(distIdx); // e.g., "2HZO" from "WA2HZO"
        if (core.length >= 3) {
          pos = 0;
          let coreCount = 0;
          while ((pos = text.indexOf(core, pos)) !== -1) {
            coreCount++;
            pos += core.length;
          }
          // Core matches are weaker evidence — only count if there are multiple
          // and they'd push us over the threshold
          if (coreCount > count) count = Math.min(coreCount, count + 1);
        }
      }
    }

    return count;
  }

  /**
   * Count standalone occurrences of a callsign (preceded by space or start of string).
   * Prevents false matches from concatenated text like "TUN6NT" (TU + N6NT).
   */
  _countStandaloneOccurrences(text, callsign) {
    const baseCall = callsign.includes('/') ? callsign.split('/')[0] : callsign;
    const searchStr = baseCall.length >= 5 ? baseCall.slice(0, -1) : baseCall;
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(searchStr, pos)) !== -1) {
      // Must be preceded by space, start of string, or ¿
      if (pos === 0 || text[pos - 1] === ' ' || text[pos - 1] === '\u00BF') {
        count++;
      }
      pos += searchStr.length;
    }
    return count;
  }

  /**
   * Check for common false positives.
   * Catches CW abbreviations that look like callsigns (TNX5NN, RST599, etc.)
   * and truncated variants of recently-spotted callsigns.
   */
  _isFalsePositive(call) {
    const base = call.split('/')[0];

    // Common CW abbreviations/words that can form callsign-like patterns
    const falsePositives = new Set([
      'CQ', 'DE', 'QSO', 'QSL', 'QTH', 'QRZ', 'RST', 'ANT', 'RIG',
      'TNX', 'TU', 'BK', 'SK', 'AR', 'KN', 'HW', 'UR', 'ES',
      'FB', 'GA', 'GM', 'GE', 'GN', 'DR', 'OM', 'YL', 'XYL',
      'WX', 'HR', 'PSE', 'AGN', 'BT', 'CL', 'DX',
    ]);
    if (falsePositives.has(base)) return true;

    // CW abbreviation + signal report patterns that look like callsigns:
    // TNX5NN, RST599, TU5NN, NC4QP (contest name garbled), etc.
    // Check if the prefix (before district digit) is a common CW abbreviation
    const distIdx = base.search(/[0-9]/);
    if (distIdx >= 2) {
      const prefix = base.substring(0, distIdx);
      const abbrevPrefixes = new Set([
        'TNX', 'TU', 'RST', 'FB', 'HR', 'UR', 'ES', 'AGN',
        'PSE', 'BK', 'CL', 'OM', 'YL', 'HW', 'GA', 'GE',
      ]);
      if (abbrevPrefixes.has(prefix)) return true;
    }

    // Block common contest/activity abbreviations that get garbled to look like callsigns:
    // NCQP→NC4QP, ARRL→AR1L, NAQP→NA4P, CQWW→CQ1W, etc.
    // These are contest names with a digit inserted by decode error
    const contestPatterns = /^(NC[0-9]QP|NA[0-9]P|AR[0-9]L|CQ[0-9]W|SS[0-9]T)$/;
    if (contestPatterns.test(base)) return true;

    // Check if this callsign is a truncated version of a recently-spotted call
    // E.g., "WB2KA" is a substring of "WB2KAO"
    const now = Date.now();
    for (const [recentCall, ts] of this._recentSpots) {
      if (now - ts >= this._dedupWindowMs) continue;
      const recentBase = recentCall.split('/')[0];
      // If the new call is a proper prefix of a recent call (at least 1 char shorter)
      if (base.length < recentBase.length && recentBase.startsWith(base)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Set the dedup window duration.
   */
  setDedupWindow(ms) {
    this._dedupWindowMs = ms;
  }
}

module.exports = { CallsignExtractor, CALLSIGN_RE };
