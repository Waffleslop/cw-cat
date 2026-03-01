// Callsign extractor: finds amateur radio callsigns in decoded Morse text
// Looks for CQ/DE patterns and validates callsign format

// Standard amateur callsign pattern:
// 1-3 chars prefix (letter/digit), at least one digit, 1-4 chars suffix ending in letter
// Examples: W1AW, KA1ABC, VE3NEA, 4X1RF, 3DA0RN
const CALLSIGN_RE = /\b([A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z])\b/g;

// CQ calling patterns
const CQ_PATTERNS = [
  // "CQ CQ CQ DE W1AW W1AW K"
  /CQ\s+(?:CQ\s+)*(?:DX\s+)?DE\s+([A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z])/,
  // "CQ CQ W1AW W1AW"
  /CQ\s+(?:CQ\s+)*(?:DX\s+)?([A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z])/,
  // "DE W1AW"
  /DE\s+([A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z])/,
  // "TEST W1AW" or "TEST DE W1AW"
  /TEST\s+(?:DE\s+)?([A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z])/,
  // Concatenated CQ (common decode artifact): "CQDEWB8ZUR" or "CQCQDEW1AW"
  /CQ(?:CQ)*DE([A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z])/,
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
    this._dedupWindowMs = 60000; // 60 seconds
  }

  /**
   * Extract callsigns from decoded Morse text.
   * @param {string} text - Decoded text (uppercase)
   * @returns {Array<{callsign: string, type: string}>}
   */
  extract(text) {
    const upper = text.toUpperCase();
    const results = [];
    const seen = new Set();

    // Try structured patterns first (CQ, DE, TEST)
    for (const pattern of CQ_PATTERNS) {
      const m = upper.match(pattern);
      if (m && m[1]) {
        const call = m[1];
        if (!seen.has(call) && this._isValidCallsign(call)) {
          // Require callsign (or close variant) appears at least twice in text
          // This prevents false spots from single garbled decodes
          const callCount = this._countCallsignOccurrences(upper, call);
          if (callCount < 2) continue;

          let type = 'CQ';
          if (upper.includes('TEST')) type = 'TEST';
          else if (upper.includes('DX')) type = 'CQ DX';
          results.push({ callsign: call, type });
          seen.add(call);
        }
      }
    }

    // No fallback regex — only extract callsigns with CQ/DE/TEST context
    // This prevents false positives from gibberish text matching callsign patterns

    return results;
  }

  /**
   * Extract and dedup: returns only callsigns not spotted recently.
   * @param {string} text
   * @returns {Array<{callsign: string, type: string}>}
   */
  extractNew(text) {
    const all = this.extract(text);
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
      if (!lastSeen || (now - lastSeen) >= this._dedupWindowMs) {
        fresh.push(result);
        this._recentSpots.set(result.callsign, now);
      }
    }

    return fresh;
  }

  /**
   * Validate a callsign string.
   */
  _isValidCallsign(call) {
    // Must have at least 4 characters (shortest valid: W1AW)
    if (call.length < 4) return false;
    if (call.length > 8) return false;

    // Must contain at least one digit and one letter
    if (!/[0-9]/.test(call)) return false;
    if (!/[A-Z]/.test(call)) return false;

    // Must end with a letter
    if (!/[A-Z]$/.test(call)) return false;

    // Prefix must contain at least one letter (before the digit)
    const digitIdx = call.search(/[0-9]/);
    const prefixPart = call.substring(0, digitIdx);
    if (prefixPart.length === 0 || !/[A-Z]/.test(prefixPart)) return false;

    // Suffix (after last digit in prefix area) must have at least 1 letter
    const suffixPart = call.substring(digitIdx + 1);
    if (suffixPart.length === 0) return false;

    // Validate against cty.dat if available
    if (this._resolveCallsign && this._ctyDb) {
      const entity = this._resolveCallsign(call, this._ctyDb);
      if (!entity) return false;
    }

    return true;
  }

  /**
   * Count occurrences of a callsign in text.
   * Uses the shorter of (full callsign, callsign minus last char) to catch near-matches.
   * E.g., "EA1WH" also counts "EA1W" matches (garbled trailing char is common).
   */
  _countCallsignOccurrences(text, callsign) {
    // For longer callsigns, match prefix (all but last char) to catch garbled variants
    const searchStr = callsign.length >= 5 ? callsign.slice(0, -1) : callsign;
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(searchStr, pos)) !== -1) {
      count++;
      pos += searchStr.length;
    }
    return count;
  }

  /**
   * Check for common false positives (words that look like callsigns).
   */
  _isFalsePositive(call) {
    const falsePositives = new Set([
      'CQ', 'DE', 'QSO', 'QSL', 'QTH', 'QRZ', 'RST', 'ANT', 'RIG',
      'TNX', 'TU', 'BK', 'SK', 'AR', 'KN', 'HW', 'UR', 'ES',
      'FB', 'GA', 'GM', 'GE', 'GN', 'DR', 'OM', 'YL', 'XYL',
      'WX', 'HR', 'PSE', 'AGN', 'BT', 'CL', 'DX',
    ]);
    return falsePositives.has(call);
  }

  /**
   * Set the dedup window duration.
   */
  setDedupWindow(ms) {
    this._dedupWindowMs = ms;
  }
}

module.exports = { CallsignExtractor, CALLSIGN_RE };
