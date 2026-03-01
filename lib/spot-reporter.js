// Spot reporter: formats and dispatches decoded CW spots to all outputs
// Handles rate limiting, dedup, and formatting

class SpotReporter {
  /**
   * @param {string} myCallsign - Operator's callsign (used as spotter)
   */
  constructor(myCallsign) {
    this._myCallsign = myCallsign || '';
    this._rbn = null;
    this._dxCluster = null;
    this._smartSdr = null;

    // Rate limiting: max 1 spot per callsign per 60 seconds
    this._lastSpotTime = new Map(); // callsign → timestamp (ms)
    this._rateLimitMs = 60000;

    // Statistics
    this._totalSpots = 0;
    this._rbnSpots = 0;
    this._clusterSpots = 0;
    this._sdrSpots = 0;
  }

  setRbn(rbnClient) { this._rbn = rbnClient; }
  setDxCluster(clusterClient) { this._dxCluster = clusterClient; }
  setSmartSdr(smartSdrClient) { this._smartSdr = smartSdrClient; }

  /**
   * Submit a decoded spot to all configured outputs.
   * @param {object} spot
   * @param {string} spot.callsign - Decoded callsign
   * @param {number} spot.freqMHz - Frequency in MHz
   * @param {number} spot.freqKhz - Frequency in kHz
   * @param {number} spot.snr - Signal-to-noise ratio in dB
   * @param {number} spot.wpm - Decoded speed in WPM
   * @param {string} spot.type - Signal type (CQ, TEST, etc.)
   * @param {string} spot.comment - Formatted comment string
   */
  submit(spot) {
    if (!spot.callsign || !spot.freqMHz) return;

    // Rate limiting
    const now = Date.now();
    const lastTime = this._lastSpotTime.get(spot.callsign);
    if (lastTime && (now - lastTime) < this._rateLimitMs) {
      return; // Too soon, skip
    }
    this._lastSpotTime.set(spot.callsign, now);
    this._totalSpots++;

    // Clean old entries periodically
    if (this._totalSpots % 100 === 0) {
      this._cleanRateLimit();
    }

    const freqKhz = spot.freqKhz || spot.freqMHz * 1000;
    const comment = spot.comment || `CW ${spot.snr || 0} dB ${spot.wpm || 0} WPM${spot.type ? ' ' + spot.type : ''}`;

    // Submit to RBN aggregator
    if (this._rbn && this._rbn.connected) {
      this._rbn.sendSpot({
        frequency: freqKhz.toFixed(1),
        callsign: spot.callsign,
        comment,
      });
      this._rbnSpots++;
    }

    // Submit to DX Cluster
    if (this._dxCluster && this._dxCluster.connected) {
      this._dxCluster.sendSpot({
        frequency: freqKhz.toFixed(1),
        callsign: spot.callsign,
        comment,
      });
      this._clusterSpots++;
    }

    // Push to SmartSDR panadapter
    if (this._smartSdr && this._smartSdr.connected) {
      this._smartSdr.addSpot({
        freqMHz: spot.freqMHz,
        callsign: spot.callsign,
        comment: `${spot.wpm || '?'} WPM ${spot.type || ''}`.trim(),
      });
      this._sdrSpots++;
    }
  }

  /**
   * Clean old entries from rate limiter.
   */
  _cleanRateLimit() {
    const now = Date.now();
    for (const [call, ts] of this._lastSpotTime) {
      if (now - ts > this._rateLimitMs * 2) {
        this._lastSpotTime.delete(call);
      }
    }
  }

  /**
   * Get submission statistics.
   */
  getStats() {
    return {
      total: this._totalSpots,
      rbn: this._rbnSpots,
      cluster: this._clusterSpots,
      sdr: this._sdrSpots,
    };
  }
}

module.exports = { SpotReporter };
