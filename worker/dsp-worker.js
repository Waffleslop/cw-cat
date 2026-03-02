// DSP Worker thread — runs the full signal processing pipeline
// Receives IQ blocks from main thread, outputs spectrum, detected signals, and decoded spots
const { parentPort } = require('worker_threads');

// Catch unhandled errors to prevent silent worker crashes
process.on('uncaughtException', (err) => {
  console.error('[DSP] Uncaught exception:', err.message, err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('[DSP] Unhandled rejection:', err);
});
const { FftProcessor } = require('../lib/dsp/fft');
const { SignalDetector } = require('../lib/dsp/signal-detector');
const { CwChannel } = require('../lib/dsp/channelizer');
const { StftChannelizer } = require('../lib/dsp/stft-channelizer');
const { CwEnvelopeDetector } = require('../lib/dsp/goertzel');
const { MorseDecoder } = require('../lib/dsp/morse-decoder');
const { CallsignExtractor } = require('../lib/dsp/callsign-extractor');
const { loadCtyDat, resolveCallsign } = require('../lib/cty');
const { isInCwSubband } = require('../lib/bands');

// --- Configuration ---
let sampleRate = 192000;
let fftSize = 4096;
let threshold = 6;
let minWpm = 8;
let maxWpm = 60;
let ctyDb = null;
let centerFreqMHz = 0; // Slice center frequency in MHz
let pendingFreqChange = false; // Defer channel clearing to next processIqBlock()

// --- STFT channelizer toggle ---
const USE_STFT_CHANNELIZER = true; // true = shared STFT (fast), false = per-channel NCO+FIR (legacy)

// --- DSP objects ---
let fftProcessor = null;
let signalDetector = null;
let callsignExtractor = null;
let stftChannelizer = null;

// Per-channel state: Map of freqOffset → { channel, envelope, decoder, text, lastActive }
const channelState = new Map();
const MAX_CHANNELS = 75; // Increased from 50 — garbage eviction keeps noise channels low
const CHANNEL_TIMEOUT_S = 30; // Remove channels inactive for this many seconds
const MIN_SNR_FOR_CHANNEL = 12; // Raised back from 10 — too many noise channels at 10
const MIN_PERSISTENCE_FOR_CHANNEL = 6; // Faster channel creation (6 frames ≈ 65ms, was 8)
const CHANNEL_OUTPUT_RATE = 800; // Channelizer output rate in Hz
const CHANNEL_BANDWIDTH = 100;   // Channel bandwidth in Hz (100Hz balances noise rejection vs keying fidelity)

// Recently-evicted frequencies: prevents churn where a channel is evicted
// then immediately re-created at the same frequency in a loop
// Map of freqOffset → eviction time (seconds)
const recentlyEvicted = new Map();
const EVICTION_COOLDOWN_S = 15; // Don't recreate a channel within 15s of eviction

// Spectrum throttle: send at ~15fps to renderer
let lastSpectrumTime = 0;
const SPECTRUM_INTERVAL_MS = 66; // ~15fps

// Signal list throttle
let lastSignalTime = 0;
const SIGNAL_INTERVAL_MS = 500;

// Time tracking
let totalSamplesProcessed = 0;

// Diagnostics
let diagBlockCount = 0;
let diagSpectrumSent = 0;
let diagSignalsFound = 0;
let diagTransitions = 0;
let diagLastLog = Date.now();
const DIAG_INTERVAL_MS = 5000;

function initialize() {
  fftProcessor = new FftProcessor(fftSize);
  signalDetector = new SignalDetector(fftSize, sampleRate, threshold);
  callsignExtractor = new CallsignExtractor(ctyDb, resolveCallsign);

  if (USE_STFT_CHANNELIZER) {
    stftChannelizer = new StftChannelizer(sampleRate, CHANNEL_OUTPUT_RATE);
    console.log(`[DSP] STFT channelizer: fftSize=${stftChannelizer._fftSize}, hop=${stftChannelizer._hopSize}, binWidth=${stftChannelizer.binWidth.toFixed(1)}Hz, outputRate=${stftChannelizer.outputRate}Hz`);
  }

  parentPort.postMessage({ type: 'ready' });
}

function processIqBlock(iqData) {
  // Apply deferred frequency change — clear channels safely outside iteration
  if (pendingFreqChange) {
    pendingFreqChange = false;
    channelState.clear();
    recentlyEvicted.clear();
    if (USE_STFT_CHANNELIZER) stftChannelizer.clear();
  }

  const now = Date.now();
  const currentTime = totalSamplesProcessed / sampleRate;
  diagBlockCount++;

  // Periodically clean stale eviction records (every ~5s)
  if (diagBlockCount === 1) {
    for (const [freq, evTime] of recentlyEvicted) {
      if (currentTime - evTime > EVICTION_COOLDOWN_S * 2) {
        recentlyEvicted.delete(freq);
      }
    }
  }

  // Periodic diagnostics
  if (now - diagLastLog >= DIAG_INTERVAL_MS) {
    // Log IQ sample range and spectrum dB range
    let iqMin = Infinity, iqMax = -Infinity;
    for (let i = 0; i < Math.min(100, iqData.length); i++) {
      if (iqData[i] < iqMin) iqMin = iqData[i];
      if (iqData[i] > iqMax) iqMax = iqData[i];
    }
    console.log(`[DSP] blocks=${diagBlockCount}, spectrums=${diagSpectrumSent}, signals=${diagSignalsFound}, channels=${channelState.size}, threshold=${threshold}dB, transitions=${diagTransitions}`);
    console.log(`[DSP] IQ sample range: ${iqMin.toExponential(3)} to ${iqMax.toExponential(3)}`);
    // Log per-channel decode status
    for (const [key, state] of channelState) {
      const env = state.envelope;
      const dr = (env._peakMag / (env._noiseMag + 1e-10)).toFixed(1);
      const dec = state.decoder;
      const elems = dec._elements.length;
      const onHist = dec._onDurations.slice(-5).map(d => (d * 1000).toFixed(0)).join(',');
      const offHist = dec._offDurations.slice(-5).map(d => (d * 1000).toFixed(0)).join(',');
      const gaps = dec._getGapThresholds();
      const cg = (gaps.charGap * 1000).toFixed(0);
      const wg = (gaps.wordGap * 1000).toFixed(0);
      console.log(`[DSP]   ch ${key}Hz: text="${state.text.slice(-40)}" DR=${dr} ditMs=${(dec._ditDuration*1000).toFixed(0)} wpm=${dec._wpm.toFixed(0)} cg=${cg}ms wg=${wg}ms locked=${dec._speedLocked} on=[${onHist}] off=[${offHist}]`);
    }
    diagBlockCount = 0;
    diagSpectrumSent = 0;
    diagSignalsFound = 0;
    diagTransitions = 0;
    diagLastLog = now;
  }

  // Validate IQ block size matches FFT size
  if (iqData.length !== fftSize * 2) {
    if (diagBlockCount <= 3) {
      console.log(`[DSP] WARNING: iq block length ${iqData.length} != expected ${fftSize * 2}`);
    }
    return;
  }

  // 1. FFT — compute spectrum
  const spectrum = fftProcessor.process(iqData);

  // Log spectrum dB range periodically
  if (diagBlockCount === 1) {
    let sMin = Infinity, sMax = -Infinity;
    for (let i = 0; i < spectrum.length; i++) {
      if (spectrum[i] > -200 && spectrum[i] < sMin) sMin = spectrum[i];
      if (spectrum[i] > sMax) sMax = spectrum[i];
    }
    console.log(`[DSP] Spectrum dB range: ${sMin.toFixed(1)} to ${sMax.toFixed(1)} dB`);
  }

  // Send spectrum to renderer (throttled)
  if (now - lastSpectrumTime >= SPECTRUM_INTERVAL_MS) {
    lastSpectrumTime = now;
    diagSpectrumSent++;
    // Send a copy since the internal buffer is reused
    parentPort.postMessage({
      type: 'spectrum',
      data: {
        magnitudes: Array.from(spectrum),
        fftSize,
        sampleRate,
        binWidth: sampleRate / fftSize,
      },
    });
  }

  // 2. Signal detection — find peaks
  const signals = signalDetector.detect(spectrum);
  diagSignalsFound += signals.length;

  // Send signal list (throttled)
  if (now - lastSignalTime >= SIGNAL_INTERVAL_MS) {
    lastSignalTime = now;
    parentPort.postMessage({
      type: 'signals',
      data: signals.map(s => ({
        freqOffset: s.freqOffset,
        magnitude: s.magnitude,
        snr: s.snr,
      })),
    });
  }

  // 3. Manage channels — add new, remove stale
  for (const sig of signals) {
    const key = Math.round(sig.freqOffset);

    // Check if too close to an existing channel (within 300 Hz)
    let tooClose = false;
    for (const existingKey of channelState.keys()) {
      const freqDelta = Math.abs(key - existingKey);
      if (freqDelta < 300) {
        tooClose = true;
        const existing = channelState.get(existingKey);
        existing.lastActive = currentTime;
        if (sig.snr > existing.snr) existing.snr = sig.snr;

        // Frequency drift tracking: if signal moved >20Hz but <150Hz, update channel
        // This keeps the channelizer centered on the actual signal as it drifts
        const actualDelta = sig.freqOffset - existing.freqOffset;
        if (Math.abs(actualDelta) > 20 && Math.abs(actualDelta) < 150) {
          // Smooth the frequency update to avoid jitter
          const newFreq = existing.freqOffset * 0.8 + sig.freqOffset * 0.2;
          if (USE_STFT_CHANNELIZER) {
            stftChannelizer.updateChannelFreq(existingKey, newFreq);
          } else {
            existing.channel.setFreqOffset(newFreq);
          }
          existing.freqOffset = newFreq;
        }
        break;
      }
    }

    if (!tooClose && !channelState.has(key) && sig.snr >= MIN_SNR_FOR_CHANNEL) {
      // Check eviction cooldown — prevent churn (delete+recreate cycles)
      // Use proximity check since signal detector gives slightly different offsets each frame
      let inCooldown = false;
      for (const [evFreq, evTime] of recentlyEvicted) {
        if ((currentTime - evTime) < EVICTION_COOLDOWN_S && Math.abs(key - evFreq) < 300) {
          inCooldown = true;
          break;
        }
      }
      if (inCooldown) continue;

      // Filter by CW sub-band — only create channels for signals in CW portions
      if (centerFreqMHz > 0) {
        const absFreqMHz = centerFreqMHz + sig.freqOffset / 1e6;
        if (!isInCwSubband(absFreqMHz)) continue;
      }

      // Only create channels for signals with high persistence (well-established)
      if (sig.persistence && sig.persistence >= MIN_PERSISTENCE_FOR_CHANNEL) {
        // If at capacity, evict the lowest-quality channel
        if (channelState.size >= MAX_CHANNELS) {
          let worstKey = null, worstScore = Infinity;
          for (const [ek, es] of channelState) {
            // Score channels by quality: text diversity + SNR + age
            const textClean = es.text.replace(/[\s¿EIST]/g, '');
            const hasQualityText = textClean.length >= 4;
            const isLocked = es.decoder._speedLocked;
            // Garbage channels (locked but only E/I/S/T) get lowest priority
            const totalText = es.text.replace(/[\s]/g, '');
            const isGarbage = totalText.length > 8 &&
              (totalText.replace(/[EIST¿]/g, '').length / totalText.length) < 0.2;
            let score = es.snr;
            if (hasQualityText) score += 200;   // Strong boost for real text
            else if (isLocked && !isGarbage) score += 50; // Mild boost for locked non-garbage
            else if (isGarbage) score -= 50;    // Penalty for garbage channels
            if (score < worstScore) { worstScore = score; worstKey = ek; }
          }
          if (worstKey !== null && worstScore < sig.snr + 50) {
            recentlyEvicted.set(worstKey, currentTime);
            const evictedState = channelState.get(worstKey);
            if (USE_STFT_CHANNELIZER) stftChannelizer.removeChannel(worstKey);
            channelState.delete(worstKey);
          } else {
            continue; // New signal isn't worth evicting any existing channel
          }
        }

        // Create channel — STFT mode registers a bin, legacy mode creates NCO+FIR
        const outputRate = USE_STFT_CHANNELIZER ? stftChannelizer.outputRate : CHANNEL_OUTPUT_RATE;
        let cwChannel = null;
        if (USE_STFT_CHANNELIZER) {
          stftChannelizer.addChannel(sig.freqOffset);
        } else {
          cwChannel = new CwChannel(sig.freqOffset, sampleRate, CHANNEL_OUTPUT_RATE, CHANNEL_BANDWIDTH);
        }
        const absKHz = centerFreqMHz > 0 ? ((centerFreqMHz + sig.freqOffset / 1e6) * 1000).toFixed(1) : '?';
        console.log(`[DSP] New channel: ${sig.freqOffset.toFixed(0)} Hz (${absKHz} kHz), SNR=${sig.snr.toFixed(1)}, outputRate=${outputRate}${USE_STFT_CHANNELIZER ? ' [STFT]' : ''}`);
        channelState.set(key, {
          channel: cwChannel,   // CwChannel (legacy) or null (STFT mode)
          envelope: new CwEnvelopeDetector(outputRate),
          decoder: new MorseDecoder(minWpm, maxWpm),
          text: '',           // Full accumulated text across decoder resets
          lastDecoderText: '', // Last seen decoder.text (for change detection)
          lastActive: currentTime,    // Updated by signal detector — keeps channel alive
          lastKeyTime: currentTime,   // Updated only on actual transitions — controls decoder reset
          createdTime: currentTime,   // When this channel was first created
          freqOffset: sig.freqOffset,
          snr: sig.snr,
        });
      }
    } else if (channelState.has(key)) {
      channelState.get(key).lastActive = currentTime;
      channelState.get(key).snr = sig.snr;
    }
  }

  // Remove timed-out channels and garbage channels
  for (const [key, state] of channelState) {
    const age = currentTime - state.lastActive;
    let shouldRemove = false;

    // QSB-resistant timeout: channels with quality text get a longer grace period
    // Just having speed locked is NOT enough — false locks on noise happen frequently
    // Require actual meaningful decoded text (non-garbage) to qualify
    const textNoGarbage = state.text.replace(/[\s¿EIST]/g, '');
    const hasUsefulContent = textNoGarbage.length >= 4;
    const effectiveTimeout = hasUsefulContent ? CHANNEL_TIMEOUT_S * 2 : CHANNEL_TIMEOUT_S;

    if (age > effectiveTimeout) {
      shouldRemove = true;
    } else if (currentTime - (state.createdTime || 0) > 8) {
      // After 8 seconds, evict channels producing only garbage
      const text = state.text.replace(/[\s]/g, '');
      if (text.length > 0) {
        // Count chars that are NOT garbage indicators (E/I/S/T/H/¿/5 — short Morse elements)
        // H (....),  5 (.....) are also common noise products
        const meaningfulChars = text.replace(/[EIST¿H5]/g, '').length;
        const garbageRatio = 1 - (meaningfulChars / text.length);
        if (garbageRatio > 0.70 && text.length > 6) {
          // More than 70% garbage characters — this is noise, not CW
          shouldRemove = true;
        }

        // Monotony check: if >60% of text is one single character, it's a carrier/non-CW
        // (e.g., "TTTTTTTTT" from a steady carrier decoded as all dahs)
        if (text.length > 10) {
          const charCounts = {};
          for (const ch of text) charCounts[ch] = (charCounts[ch] || 0) + 1;
          const maxCount = Math.max(...Object.values(charCounts));
          if (maxCount / text.length > 0.60) {
            shouldRemove = true;
          }
        }
      }
    }

    if (shouldRemove) {
      // Flush any pending decode
      state.decoder.flush();
      const finalText = state.decoder.text;
      if (finalText !== state.lastDecoderText) {
        const newChars = finalText.startsWith(state.lastDecoderText)
          ? finalText.slice(state.lastDecoderText.length)
          : finalText;
        state.text += newChars;
      }
      if (state.text.length > 3) {
        tryExtractCallsign(key, state);
      }
      // Record eviction to prevent immediate re-creation (churn)
      recentlyEvicted.set(key, currentTime);
      if (USE_STFT_CHANNELIZER) stftChannelizer.removeChannel(key);
      channelState.delete(key);
    }
  }

  // 4. Per-channel processing: channelizer → envelope → Morse decoder
  // STFT mode: one shared FFT produces all channels at once (~36x faster)
  // Legacy mode: per-channel NCO+FIR decimation
  let stftResults = null;
  if (USE_STFT_CHANNELIZER && channelState.size > 0) {
    stftResults = stftChannelizer.processBlock(iqData);
  }

  for (const [key, state] of channelState) {
    // Get channel magnitudes — from STFT bulk result or legacy per-channel processing
    let magnitudes;
    if (USE_STFT_CHANNELIZER) {
      magnitudes = stftResults ? stftResults.get(key) : null;
      if (!magnitudes || magnitudes.length === 0) continue;
    } else {
      magnitudes = state.channel.process(iqData);
      if (magnitudes.length === 0) continue;
    }

    // Feed magnitude samples to envelope detector
    const outputRate = USE_STFT_CHANNELIZER ? stftChannelizer.outputRate : state.channel.outputRate;
    const transitions = state.envelope.process(magnitudes, outputRate);

    // Check dynamic range — need sufficient contrast for CW detection
    // Graduated threshold: strict before speed lock, lenient after
    // After lock we know it's real CW so we can trust weaker signals
    const dr = state.envelope._peakMag / (state.envelope._noiseMag + 1e-10);
    const drThreshold = state.decoder._speedLocked ? 3.0 : 5.0;
    if (dr < drThreshold) continue;

    // Feed transitions to Morse decoder
    diagTransitions += transitions.length;
    if (transitions.length > 0) {
      state.decoder.feedTransitions(transitions);
      state.lastKeyTime = currentTime;

      // Check for decoded text — only report if text has meaningful length
      const decoderText = state.decoder.text;
      if (decoderText !== state.lastDecoderText && decoderText.length >= 2) {
        // Compute what's new since last check
        const newChars = decoderText.startsWith(state.lastDecoderText)
          ? decoderText.slice(state.lastDecoderText.length)
          : decoderText;  // After decoder reset, all text is "new"

        const prevFullText = state.text;
        state.text += newChars;
        state.lastDecoderText = decoderText;

        // Send decode update to renderer (throttle per channel)
        parentPort.postMessage({
          type: 'decode',
          data: {
            freqOffset: state.freqOffset,
            text: state.text,
            wpm: state.decoder.wpm,
            snr: state.snr,
          },
        });

        // Try to extract callsign only on word boundaries (space added)
        // This prevents premature extraction as callsign builds character by character
        if (state.text.length > prevFullText.length && state.text.endsWith(' ')) {
          tryExtractCallsign(key, state);
        }
      }
    }

    // Check for transmission timeout — use lastKeyTime (last actual keying) for decoder reset
    // Use a consistent 3-5s timeout, clamped to prevent issues at extreme WPM
    const silenceSec = currentTime - state.lastKeyTime;
    const timeoutSec = Math.min(Math.max(state.decoder._ditDuration * 25, 3.0), 8.0);
    if (state.decoder._started && silenceSec > timeoutSec) {
      state.decoder.flush();
      // Append any final text from the decoder before resetting
      const finalText = state.decoder.text;
      if (finalText !== state.lastDecoderText) {
        const newChars = finalText.startsWith(state.lastDecoderText)
          ? finalText.slice(state.lastDecoderText.length)
          : finalText;
        state.text += newChars;
      }
      if (state.text.length > 3) {
        tryExtractCallsign(key, state);
      }
      // Add a space separator between transmissions
      state.text += ' ';
      // Reset decoder for next transmission (preserves speed estimate)
      state.decoder.reset();
      state.lastDecoderText = '';
      // Trim old text to prevent unbounded growth, keep last 200 chars
      if (state.text.length > 400) {
        state.text = state.text.slice(-200);
      }
    }
  }

  totalSamplesProcessed += iqData.length / 2; // iqData is interleaved I/Q
}

function tryExtractCallsign(key, state) {
  // Use recent text window to avoid re-matching old patterns
  // 160 chars keeps CQ/DE context visible longer as text scrolls (was 120)
  const text = state.text.length > 160 ? state.text.slice(-160) : state.text;
  // Require at least 8 characters — "CQ W1AW" is 7, "DE W1AW" is 7
  if (text.length < 8) return;

  // Require recognizable CW context words to avoid false positives from gibberish
  // Also accept garbled variants: NST/EST/IST for TEST, concatenated DEXXX
  const hasContext = /(?:CQ|DE|[NEIT]ST)/.test(text);
  // Also check if text has a repeated callsign-like pattern (self-evident context)
  // This catches "WA2VUY WA2VUY WA2VUY" — repeated callsigns ARE context
  const hasRepeatedCall = !hasContext && /\b([A-Z0-9]{1,3}[0-9][A-Z]{1,4})\b.*\b\1\b/.test(text);
  if (!hasContext && !hasRepeatedCall && state.snr < 20) return;

  const results = callsignExtractor.extractNew(text, state.snr);
  for (const { callsign, type } of results) {
    console.log(`[DSP] SPOT FOUND: ${callsign} (${type}) @ ${state.freqOffset.toFixed(0)}Hz — "${text.slice(-40)}"`);
    parentPort.postMessage({
      type: 'spot',
      data: {
        callsign,
        freqOffset: state.freqOffset,
        snr: Math.round(state.snr || 0),
        wpm: state.decoder.wpm,
        type,
        text,
      },
    });
  }
}

// --- Message handler ---
parentPort.on('message', (msg) => {
  try {
    switch (msg.type) {
      case 'configure':
        if (msg.sampleRate) sampleRate = msg.sampleRate;
        if (msg.fftSize) fftSize = msg.fftSize;
        if (msg.threshold) threshold = msg.threshold;
        if (msg.minWpm) minWpm = msg.minWpm;
        if (msg.maxWpm) maxWpm = msg.maxWpm;

        // Load cty.dat if path provided and not yet loaded
        if (msg.ctyDatPath && !ctyDb) {
          try {
            ctyDb = loadCtyDat(msg.ctyDatPath);
            console.log(`[DSP] Loaded cty.dat: ${ctyDb.entities.length} entities`);
          } catch (err) {
            console.error('[DSP] Failed to load cty.dat:', err.message);
          }
        }

        if (signalDetector) signalDetector.setThreshold(threshold);

        // Reinitialize if FFT size or sample rate changed
        if (!fftProcessor || fftProcessor.size !== fftSize) {
          initialize();
        }
        break;

      case 'iq-block': {
        const iqData = new Float32Array(msg.block);
        processIqBlock(iqData);
        break;
      }

      case 'set-center-freq':
        if (msg.centerMHz && msg.centerMHz !== centerFreqMHz) {
          centerFreqMHz = msg.centerMHz;
          console.log(`[DSP] Center frequency: ${centerFreqMHz.toFixed(6)} MHz`);
          // Defer channel clearing to next processIqBlock() to avoid race conditions
          pendingFreqChange = true;
        }
        break;

      case 'stop':
        channelState.clear();
        if (USE_STFT_CHANNELIZER) stftChannelizer.clear();
        break;
    }
  } catch (err) {
    console.error('[DSP] Worker error:', err.message, err.stack);
  }
});

// Initialize on startup
initialize();
