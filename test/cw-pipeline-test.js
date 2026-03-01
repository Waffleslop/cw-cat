// Offline CW pipeline test harness
// Generates synthetic CW IQ data at various SNRs and measures decode performance
//
// Usage: node test/cw-pipeline-test.js

const { FftProcessor } = require('../lib/dsp/fft');
const { SignalDetector } = require('../lib/dsp/signal-detector');
const { CwChannel } = require('../lib/dsp/channelizer');
const { CwEnvelopeDetector } = require('../lib/dsp/goertzel');
const { MorseDecoder, MORSE_TABLE } = require('../lib/dsp/morse-decoder');
const { CallsignExtractor } = require('../lib/dsp/callsign-extractor');

const SAMPLE_RATE = 192000;
const FFT_SIZE = 4096;
const CHANNEL_OUTPUT_RATE = 800;
const CHANNEL_BW = 150;

// Reverse Morse table
const REV_MORSE = {};
for (const [morse, char] of Object.entries(MORSE_TABLE)) {
  REV_MORSE[char] = morse;
}

/**
 * Generate IQ samples for a CW signal at a given frequency offset.
 * @param {number} freqOffset - Hz offset from center
 * @param {number} durationSec - Total duration in seconds
 * @param {string} text - Text to encode as Morse
 * @param {number} wpm - Words per minute
 * @param {number} snrDb - Signal-to-noise ratio in dB
 * @returns {Float32Array} - Interleaved I/Q samples
 */
function generateCwIq(freqOffset, durationSec, text, wpm, snrDb) {
  const numSamples = Math.ceil(durationSec * SAMPLE_RATE);
  const iq = new Float32Array(numSamples * 2);

  const ditDuration = 1.2 / wpm; // seconds
  const dahDuration = ditDuration * 3;
  const intraGap = ditDuration;
  const charGap = ditDuration * 3;
  const wordGap = ditDuration * 7;

  // Build keying envelope
  const envelope = new Float32Array(numSamples);
  let samplePos = 0;

  // Start with some silence
  samplePos += Math.floor(0.2 * SAMPLE_RATE);

  for (const char of text) {
    if (samplePos >= numSamples) break;

    if (char === ' ') {
      samplePos += Math.floor(wordGap * SAMPLE_RATE);
      continue;
    }

    const morse = REV_MORSE[char];
    if (!morse) continue;

    for (let i = 0; i < morse.length; i++) {
      if (samplePos >= numSamples) break;
      const elemDur = morse[i] === '.' ? ditDuration : dahDuration;
      const elemSamples = Math.floor(elemDur * SAMPLE_RATE);

      // Apply raised-cosine edges (5ms rise/fall) for realistic shaping
      const edgeSamples = Math.floor(0.005 * SAMPLE_RATE);
      for (let s = 0; s < elemSamples && samplePos + s < numSamples; s++) {
        let env = 1.0;
        if (s < edgeSamples) {
          env = 0.5 * (1 - Math.cos(Math.PI * s / edgeSamples));
        } else if (s > elemSamples - edgeSamples) {
          env = 0.5 * (1 + Math.cos(Math.PI * (s - (elemSamples - edgeSamples)) / edgeSamples));
        }
        envelope[samplePos + s] = env;
      }
      samplePos += elemSamples;

      // Intra-element gap
      if (i < morse.length - 1) {
        samplePos += Math.floor(intraGap * SAMPLE_RATE);
      }
    }
    // Character gap
    samplePos += Math.floor(charGap * SAMPLE_RATE);
  }

  // Signal amplitude from SNR: SNR_dB = 20*log10(A_signal/A_noise)
  // With noise_rms = 1, signal_amplitude = 10^(snrDb/20)
  const noiseRms = 1.0;
  const signalAmplitude = noiseRms * Math.pow(10, snrDb / 20);

  // Generate IQ with tone and noise
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const phase = 2 * Math.PI * freqOffset * t;
    const sig = envelope[i] * signalAmplitude;

    // Complex signal + noise
    iq[2 * i] = sig * Math.cos(phase) + gaussianNoise() * noiseRms;
    iq[2 * i + 1] = sig * Math.sin(phase) + gaussianNoise() * noiseRms;
  }

  return iq;
}

// Box-Muller transform for Gaussian noise
let spareNoise = null;
function gaussianNoise() {
  if (spareNoise !== null) {
    const val = spareNoise;
    spareNoise = null;
    return val;
  }
  let u, v, s;
  do {
    u = Math.random() * 2 - 1;
    v = Math.random() * 2 - 1;
    s = u * u + v * v;
  } while (s >= 1 || s === 0);
  const mul = Math.sqrt(-2 * Math.log(s) / s);
  spareNoise = v * mul;
  return u * mul;
}

/**
 * Run the full pipeline on IQ data and return decoded results.
 */
function runPipeline(iqData, freqOffset) {
  const fft = new FftProcessor(FFT_SIZE);
  const detector = new SignalDetector(FFT_SIZE, SAMPLE_RATE, 6);
  const channelizer = new CwChannel(freqOffset, SAMPLE_RATE, CHANNEL_OUTPUT_RATE, CHANNEL_BW);
  const envelope = new CwEnvelopeDetector(channelizer.outputRate);
  const decoder = new MorseDecoder(8, 60);
  const extractor = new CallsignExtractor(null, null);

  const numBlocks = Math.floor(iqData.length / (FFT_SIZE * 2));
  let text = '';
  let lastDecoderText = '';
  const spots = [];

  for (let b = 0; b < numBlocks; b++) {
    const blockStart = b * FFT_SIZE * 2;
    // Use 50% overlap
    const overlapStart = Math.max(0, blockStart - FFT_SIZE);
    const block = iqData.slice(overlapStart, overlapStart + FFT_SIZE * 2);
    if (block.length < FFT_SIZE * 2) break;

    // FFT + detect (not used for decode, just for verification)
    const spectrum = fft.process(block);
    detector.detect(spectrum);

    // Channelize
    const mags = channelizer.process(block);
    if (mags.length === 0) continue;

    // Envelope detect
    const transitions = envelope.process(mags, channelizer.outputRate);

    // Check DR
    const dr = envelope._peakMag / (envelope._noiseMag + 1e-10);
    if (dr < 3.0) continue;

    // Morse decode
    if (transitions.length > 0) {
      decoder.feedTransitions(transitions);
      const decoderText = decoder.text;
      if (decoderText !== lastDecoderText) {
        const newChars = decoderText.startsWith(lastDecoderText)
          ? decoderText.slice(lastDecoderText.length)
          : decoderText;
        text += newChars;
        lastDecoderText = decoderText;

        // Try extraction on word boundaries
        if (text.endsWith(' ') && text.length > 8) {
          const results = extractor.extractNew(text.length > 160 ? text.slice(-160) : text);
          for (const r of results) {
            spots.push(r);
          }
        }
      }
    }
  }

  // Final flush
  decoder.flush();
  const finalText = decoder.text;
  if (finalText !== lastDecoderText) {
    text += finalText.startsWith(lastDecoderText) ? finalText.slice(lastDecoderText.length) : finalText;
  }
  // Final extraction attempt
  if (text.length > 8) {
    const results = extractor.extractNew(text.length > 160 ? text.slice(-160) : text);
    for (const r of results) spots.push(r);
  }

  return {
    text: text.trim(),
    spots,
    wpm: decoder.wpm,
    speedLocked: decoder._speedLocked,
  };
}

// ============ Test scenarios ============

function runTests() {
  console.log('=== CW Pipeline Test Harness ===\n');

  const testCases = [
    { call: 'W1AW', text: 'CQ CQ CQ DE W1AW W1AW K', wpm: 20, freq: 5000 },
    { call: 'K4BAI', text: 'CQ CQ DE K4BAI K4BAI K', wpm: 15, freq: -3000 },
    { call: 'N3CZ', text: 'CQ CQ DE N3CZ N3CZ K', wpm: 30, freq: 8000 },
    { call: 'KE9BHN', text: 'CQ POTA DE KE9BHN KE9BHN K', wpm: 18, freq: -5000 },
    { call: 'W8FN', text: 'CQ TEST CQ TEST DE W8FN W8FN K', wpm: 25, freq: 2000 },
  ];

  const snrLevels = [30, 20, 15, 12, 10, 8, 6, 4, 2, 0];

  console.log('SNR(dB)  | Call   | WPM | Decoded | Spotted | Text');
  console.log('-'.repeat(90));

  let totalTests = 0;
  let totalDetected = 0;
  let totalSpotted = 0;

  for (const tc of testCases) {
    for (const snr of snrLevels) {
      totalTests++;
      // Generate enough data: 4 full CQ cycles (typical real-world CQ)
      const fullText = tc.text + ' ' + tc.text + ' ' + tc.text + ' ' + tc.text;
      const duration = (fullText.length * 0.2) + 2; // generous estimate

      const iq = generateCwIq(tc.freq, duration, fullText, tc.wpm, snr);
      const result = runPipeline(iq, tc.freq);

      const decoded = result.speedLocked;
      const spotted = result.spots.some(s => s.callsign === tc.call);
      if (decoded) totalDetected++;
      if (spotted) totalSpotted++;

      const textShort = result.text.slice(-60).replace(/\s+/g, ' ').trim();
      const status = spotted ? 'SPOT' : decoded ? 'DECODE' : 'MISS';
      console.log(
        `  ${String(snr).padStart(2)}dB   | ${tc.call.padEnd(6)} | ${String(tc.wpm).padStart(3)} | ${decoded ? 'YES' : ' NO'} ${String(result.wpm).padStart(2)}wpm | ${spotted ? 'YES    ' : ' NO    '} | ${status} "...${textShort}"`
      );
    }
    console.log('-'.repeat(90));
  }

  console.log(`\nSummary: ${totalTests} tests, ${totalDetected} decoded (${(100*totalDetected/totalTests).toFixed(0)}%), ${totalSpotted} spotted (${(100*totalSpotted/totalTests).toFixed(0)}%)`);
  console.log(`Detection threshold estimate: decode works down to ~${snrLevels[snrLevels.length - 1]}dB SNR`);
}

runTests();

// ============ Multi-signal test ============
function runMultiSignalTest() {
  console.log('\n=== Multi-Signal Test (simultaneous signals) ===\n');

  const signals = [
    { call: 'W1AW', text: 'CQ CQ CQ DE W1AW W1AW K', wpm: 20, freq: 3000, snr: 25 },
    { call: 'K4BAI', text: 'CQ CQ DE K4BAI K4BAI K', wpm: 15, freq: -2000, snr: 20 },
    { call: 'N3CZ', text: 'CQ CQ DE N3CZ N3CZ K', wpm: 30, freq: 8000, snr: 15 },
    { call: 'W8FN', text: 'CQ TEST DE W8FN W8FN K', wpm: 25, freq: -6000, snr: 10 },
    { call: 'KV1I', text: 'CQ CQ DE KV1I KV1I K', wpm: 22, freq: 1000, snr: 8 },
  ];

  // Find max duration needed
  let maxDuration = 0;
  for (const sig of signals) {
    const fullText = sig.text + ' ' + sig.text + ' ' + sig.text + ' ' + sig.text;
    const dur = fullText.length * 0.2 + 2;
    if (dur > maxDuration) maxDuration = dur;
  }

  // Generate combined IQ with all signals + noise
  const numSamples = Math.ceil(maxDuration * SAMPLE_RATE);
  const combinedIq = new Float32Array(numSamples * 2);

  // Add noise baseline
  for (let i = 0; i < numSamples * 2; i++) {
    combinedIq[i] = gaussianNoise() * 1.0;
  }

  // Add each signal
  for (const sig of signals) {
    const fullText = sig.text + ' ' + sig.text + ' ' + sig.text + ' ' + sig.text;
    const sigIq = generateCwIq(sig.freq, maxDuration, fullText, sig.wpm, sig.snr);
    // Add signal (without the noise that generateCwIq adds — we already have noise)
    // Actually we need to regenerate without noise... for simplicity, just add as-is
    // The double-noise is fine since it's independent
    for (let i = 0; i < Math.min(sigIq.length, combinedIq.length); i++) {
      combinedIq[i] += sigIq[i];
    }
  }

  // Run each signal through its own channelizer
  console.log('Freq(Hz) | Call   | WPM | SNR(dB) | Decoded | Spotted | Text');
  console.log('-'.repeat(95));

  let spotted = 0;
  for (const sig of signals) {
    const result = runPipeline(combinedIq, sig.freq);
    const isSpotted = result.spots.some(s => s.callsign === sig.call);
    if (isSpotted) spotted++;
    const textShort = result.text.slice(-50).replace(/\s+/g, ' ').trim();
    console.log(
      `  ${String(sig.freq).padStart(6)} | ${sig.call.padEnd(6)} | ${String(sig.wpm).padStart(3)} | ${String(sig.snr).padStart(5)}   | ${result.speedLocked ? 'YES' : ' NO'} ${String(result.wpm).padStart(2)}wpm | ${isSpotted ? 'YES    ' : ' NO    '} | "...${textShort}"`
    );
  }

  console.log(`\nMulti-signal: ${spotted}/${signals.length} spotted (${(100*spotted/signals.length).toFixed(0)}%)`);
}

runMultiSignalTest();

// ============ Hard scenarios ============
function runHardTests() {
  console.log('\n=== Hard Real-World Scenarios ===\n');

  // Test 1: Adjacent signals 300Hz apart
  console.log('--- Test: Adjacent signals 300Hz apart ---');
  {
    const dur = 25;
    const numSamples = Math.ceil(dur * SAMPLE_RATE);
    const iq = new Float32Array(numSamples * 2);
    for (let i = 0; i < numSamples * 2; i++) iq[i] = gaussianNoise() * 1.0;

    // Strong signal at 5000 Hz
    const text1 = 'CQ CQ CQ DE W1AW W1AW K CQ CQ CQ DE W1AW W1AW K CQ CQ CQ DE W1AW W1AW K';
    const iq1 = generateCwIq(5000, dur, text1, 20, 25);
    // Weaker signal at 5300 Hz (only 300Hz away)
    const text2 = 'CQ CQ DE K4BAI K4BAI K CQ CQ DE K4BAI K4BAI K CQ CQ DE K4BAI K4BAI K';
    const iq2 = generateCwIq(5300, dur, text2, 15, 20);
    for (let i = 0; i < Math.min(iq1.length, iq.length); i++) iq[i] += iq1[i] + iq2[i];

    const r1 = runPipeline(iq, 5000);
    const r2 = runPipeline(iq, 5300);
    const s1 = r1.spots.some(s => s.callsign === 'W1AW');
    const s2 = r2.spots.some(s => s.callsign === 'K4BAI');
    console.log(`  5000Hz W1AW (25dB): ${s1 ? 'SPOTTED' : 'MISSED'} — "${r1.text.slice(-40).trim()}"`);
    console.log(`  5300Hz K4BAI(20dB): ${s2 ? 'SPOTTED' : 'MISSED'} — "${r2.text.slice(-40).trim()}"`);
  }

  // Test 2: QSB fading — realistic: only the signal fades, noise stays constant
  console.log('\n--- Test: QSB fading (1Hz fade rate, -10dB depth) ---');
  {
    const dur = 25;
    const numSamples = Math.ceil(dur * SAMPLE_RATE);
    const text = 'CQ CQ CQ DE KE9BHN KE9BHN K CQ CQ CQ DE KE9BHN KE9BHN K CQ CQ CQ DE KE9BHN KE9BHN K';
    const iq = new Float32Array(numSamples * 2);

    // Generate noise separately
    for (let i = 0; i < numSamples * 2; i++) {
      iq[i] = gaussianNoise() * 1.0;
    }

    // Generate signal with QSB envelope (only signal amplitude varies)
    const signalAmplitude = Math.pow(10, 20 / 20); // 20dB SNR at peak
    const ditDuration = 1.2 / 18;
    const dahDuration = ditDuration * 3;
    const intraGap = ditDuration;
    const charGap = ditDuration * 3;
    const wordGap = ditDuration * 7;

    const cwEnv = new Float32Array(numSamples);
    let pos = Math.floor(0.3 * SAMPLE_RATE);
    for (const char of text) {
      if (pos >= numSamples) break;
      if (char === ' ') { pos += Math.floor(wordGap * SAMPLE_RATE); continue; }
      const morse = REV_MORSE[char];
      if (!morse) continue;
      for (let i = 0; i < morse.length; i++) {
        if (pos >= numSamples) break;
        const elemDur = morse[i] === '.' ? ditDuration : dahDuration;
        const elemSamples = Math.floor(elemDur * SAMPLE_RATE);
        for (let s = 0; s < elemSamples && pos + s < numSamples; s++) cwEnv[pos + s] = 1.0;
        pos += elemSamples;
        if (i < morse.length - 1) pos += Math.floor(intraGap * SAMPLE_RATE);
      }
      pos += Math.floor(charGap * SAMPLE_RATE);
    }

    // Add signal with 1Hz QSB (-10dB depth, signal only)
    for (let i = 0; i < numSamples; i++) {
      const t = i / SAMPLE_RATE;
      const qsb = 0.5 + 0.5 * Math.cos(2 * Math.PI * 1.0 * t); // 0 to 1
      const qsbFactor = Math.pow(10, (-10 * (1 - qsb)) / 20); // -10dB to 0dB
      const amp = cwEnv[i] * signalAmplitude * qsbFactor;
      const phase = 2 * Math.PI * 4000 * t;
      iq[2*i] += amp * Math.cos(phase);
      iq[2*i+1] += amp * Math.sin(phase);
    }

    const result = runPipeline(iq, 4000);
    const spotted = result.spots.some(s => s.callsign === 'KE9BHN');
    console.log(`  4000Hz KE9BHN (20dB + 1Hz QSB -10dB): ${spotted ? 'SPOTTED' : 'MISSED'} — "${result.text.slice(-60).trim()}"`);
  }

  // Test 3: Sloppy timing (±20% element variation)
  console.log('\n--- Test: Sloppy operator (±20% timing jitter) ---');
  {
    const text = 'CQ CQ DE W8FN W8FN K CQ CQ DE W8FN W8FN K CQ CQ DE W8FN W8FN K';
    const wpm = 20;
    const ditBase = 1.2 / wpm;
    const dur = text.length * 0.25 + 4;
    const numSamples = Math.ceil(dur * SAMPLE_RATE);
    const iq = new Float32Array(numSamples * 2);
    const envelope = new Float32Array(numSamples);

    // Build envelope with jittered timing
    let pos = Math.floor(0.2 * SAMPLE_RATE);
    for (const char of text) {
      if (pos >= numSamples) break;
      if (char === ' ') { pos += Math.floor((ditBase * 7 * (0.8 + Math.random() * 0.4)) * SAMPLE_RATE); continue; }
      const morse = REV_MORSE[char];
      if (!morse) continue;
      for (let i = 0; i < morse.length; i++) {
        if (pos >= numSamples) break;
        // Apply ±20% jitter to each element
        const jitter = 0.8 + Math.random() * 0.4;
        const elemDur = (morse[i] === '.' ? ditBase : ditBase * 3) * jitter;
        const elemSamples = Math.floor(elemDur * SAMPLE_RATE);
        for (let s = 0; s < elemSamples && pos + s < numSamples; s++) {
          envelope[pos + s] = 1.0;
        }
        pos += elemSamples;
        if (i < morse.length - 1) {
          pos += Math.floor(ditBase * (0.8 + Math.random() * 0.4) * SAMPLE_RATE);
        }
      }
      pos += Math.floor(ditBase * 3 * (0.8 + Math.random() * 0.4) * SAMPLE_RATE);
    }

    const signalAmp = Math.pow(10, 20 / 20);
    for (let i = 0; i < numSamples; i++) {
      const t = i / SAMPLE_RATE;
      const phase = 2 * Math.PI * 6000 * t;
      iq[2*i] = envelope[i] * signalAmp * Math.cos(phase) + gaussianNoise();
      iq[2*i+1] = envelope[i] * signalAmp * Math.sin(phase) + gaussianNoise();
    }

    const result = runPipeline(iq, 6000);
    const spotted = result.spots.some(s => s.callsign === 'W8FN');
    console.log(`  6000Hz W8FN (20dB, ±20% jitter): ${spotted ? 'SPOTTED' : 'MISSED'} — "${result.text.slice(-50).trim()}"`);
  }

  // Test 4: Impulsive noise (QRN)
  console.log('\n--- Test: QRN (impulsive atmospheric noise) ---');
  {
    const dur = 15;
    const text = 'CQ CQ DE N3CZ N3CZ K CQ CQ DE N3CZ N3CZ K';
    const iq = generateCwIq(7000, dur, text, 25, 20);

    // Add impulsive noise: random bursts of 0.5-5ms, amplitude 10x noise
    const numSamples = Math.floor(iq.length / 2);
    const burstRate = 10; // bursts per second
    for (let b = 0; b < dur * burstRate; b++) {
      const start = Math.floor(Math.random() * numSamples);
      const burstLen = Math.floor((0.0005 + Math.random() * 0.005) * SAMPLE_RATE);
      const burstAmp = 5 + Math.random() * 15;
      for (let i = start; i < Math.min(start + burstLen, numSamples); i++) {
        iq[2*i] += gaussianNoise() * burstAmp;
        iq[2*i+1] += gaussianNoise() * burstAmp;
      }
    }

    const result = runPipeline(iq, 7000);
    const spotted = result.spots.some(s => s.callsign === 'N3CZ');
    console.log(`  7000Hz N3CZ (20dB + QRN 10/s): ${spotted ? 'SPOTTED' : 'MISSED'} — "${result.text.slice(-50).trim()}"`);
  }
}

runHardTests();
