// Amateur radio band definitions: frequency ranges in MHz
const BANDS = {
  '160m': { lower: 1.800, upper: 2.000 },
  '80m':  { lower: 3.500, upper: 4.000 },
  '60m':  { lower: 5.330, upper: 5.410 },
  '40m':  { lower: 7.000, upper: 7.300 },
  '30m':  { lower: 10.100, upper: 10.150 },
  '20m':  { lower: 14.000, upper: 14.350 },
  '17m':  { lower: 18.068, upper: 18.168 },
  '15m':  { lower: 21.000, upper: 21.450 },
  '12m':  { lower: 24.890, upper: 24.990 },
  '10m':  { lower: 28.000, upper: 29.700 },
  '6m':   { lower: 50.000, upper: 54.000 },
  '2m':   { lower: 144.000, upper: 148.000 },
};

// CW sub-band ranges per band (MHz) — IARU Region 2 / US convention
// Tight ranges to exclude FT8/digital (e.g., 14.074, 7.074) and SSB
const CW_SUBBANDS = [
  { lower: 1.800, upper: 1.850 },   // 160m CW
  { lower: 3.500, upper: 3.570 },   // 80m CW
  { lower: 5.330, upper: 5.360 },   // 60m CW
  { lower: 7.000, upper: 7.060 },   // 40m CW (below 7.074 FT8)
  { lower: 10.100, upper: 10.130 }, // 30m CW (below 10.136 FT8)
  { lower: 14.000, upper: 14.070 }, // 20m CW (below 14.074 FT8)
  { lower: 18.068, upper: 18.095 }, // 17m CW (below 18.100 FT8)
  { lower: 21.000, upper: 21.070 }, // 15m CW (below 21.074 FT8)
  { lower: 24.890, upper: 24.920 }, // 12m CW (below 24.915 FT8)
  { lower: 28.000, upper: 28.070 }, // 10m CW (below 28.074 FT8)
  { lower: 50.000, upper: 50.100 }, // 6m CW
  { lower: 144.000, upper: 144.100 }, // 2m CW
];

function freqToBand(freqMHz) {
  for (const [name, { lower, upper }] of Object.entries(BANDS)) {
    if (freqMHz >= lower && freqMHz <= upper) return name;
  }
  return null;
}

/**
 * Check if a frequency (MHz) falls within a CW sub-band.
 * @param {number} freqMHz
 * @returns {boolean}
 */
function isInCwSubband(freqMHz) {
  for (const { lower, upper } of CW_SUBBANDS) {
    if (freqMHz >= lower && freqMHz <= upper) return true;
  }
  return false;
}

module.exports = { BANDS, CW_SUBBANDS, freqToBand, isInCwSubband };
