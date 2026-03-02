// CW CAT Renderer — UI logic for spectrum display, signal table, and settings
'use strict';

// --- Theme ---
function isLightTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light';
}

function applyTheme(light) {
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  // Clear waterfall when switching themes (colormap changes)
  if (typeof waterfallCtx !== 'undefined' && waterfallCtx) {
    try { waterfallCtx.clearRect(0, 0, waterfallCanvas.width, waterfallCanvas.height); } catch {}
  }
}

// --- State ---
let settings = {};
let spots = []; // Array of decoded spot objects
let activeDecoders = new Map(); // freqOffset → { text, wpm, snr }
let spectrumData = null;
let currentMode = 'skimmer'; // 'skimmer' or 'reader'
let sliceFreqMHz = 0; // Current Slice A frequency in MHz

// --- DOM refs ---
const radioDot = document.getElementById('radio-dot');
const rbnDot = document.getElementById('rbn-dot');
const clusterDot = document.getElementById('cluster-dot');
const dspDot = document.getElementById('dsp-dot');
const radioLabel = document.getElementById('radio-label');
const iqInfo = document.getElementById('iq-info');
const signalsCount = document.getElementById('signals-count');
const utcClock = document.getElementById('utc-clock');
const spotStats = document.getElementById('spot-stats');
const spotsBody = document.getElementById('spots-body');
const decodersList = document.getElementById('decoders-list');
const statusText = document.getElementById('status-text');
const spotTotal = document.getElementById('spot-total');
const spectrumCanvas = document.getElementById('spectrum-canvas');
const waterfallCanvas = document.getElementById('waterfall-canvas');
const spectrumLabel = document.getElementById('spectrum-label');
const freqAxis = document.getElementById('freq-axis');

const modeToggle = document.getElementById('mode-toggle');
const bottomContent = document.querySelector('.bottom-content');
const readerPanel = document.getElementById('reader-panel');
const readerText = document.getElementById('reader-text');
const readerFreqEl = document.getElementById('reader-freq');
const readerWpm = document.getElementById('reader-wpm');

const settingsOverlay = document.getElementById('settings-overlay');
const settingsBtn = document.getElementById('settings-btn');
const settingsCancel = document.getElementById('settings-cancel');
const settingsSave = document.getElementById('settings-save');

// Canvas contexts
const spectrumCtx = spectrumCanvas.getContext('2d');
const waterfallCtx = waterfallCanvas.getContext('2d');

// Waterfall image data for scrolling
let waterfallRow = 0;

// Auto-scaling dB range with smoothing
let autoDbMin = null;
let autoDbMax = null;
const DB_SMOOTH = 0.05; // EMA smoothing factor for scale changes

// --- UTC Clock ---
function updateClock() {
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  utcClock.textContent = `${hh}:${mm}:${ss}Z`;
}
setInterval(updateClock, 1000);
updateClock();

// --- Canvas resize ---
function resizeCanvases() {
  const container = spectrumCanvas.parentElement;
  const w = container.clientWidth;
  const h = container.clientHeight;

  // Spectrum takes top 40%, waterfall takes bottom 60%
  const specH = Math.floor(h * 0.4);
  const wfH = h - specH;

  spectrumCanvas.width = w;
  spectrumCanvas.height = specH;
  spectrumCanvas.style.height = specH + 'px';

  waterfallCanvas.width = w;
  waterfallCanvas.height = wfH;
  waterfallCanvas.style.top = specH + 'px';
  waterfallCanvas.style.height = wfH + 'px';
}

window.addEventListener('resize', resizeCanvases);
resizeCanvases();

// --- Spectrum rendering ---
function renderSpectrum(data) {
  if (!data || !data.magnitudes) return;

  let mags = data.magnitudes;
  let effectiveSampleRate = data.sampleRate;

  // In reader mode, zoom to ±READER_ZOOM_HZ around center
  if (currentMode === 'reader' && data.sampleRate) {
    const fullN = mags.length;
    const binWidth = data.sampleRate / fullN;
    const zoomBins = Math.floor(READER_ZOOM_HZ / binWidth);
    const centerBin = Math.floor(fullN / 2);
    const startBin = Math.max(0, centerBin - zoomBins);
    const endBin = Math.min(fullN, centerBin + zoomBins);
    mags = mags.slice(startBin, endBin);
    effectiveSampleRate = READER_ZOOM_HZ * 2;
  }

  const N = mags.length;
  const w = spectrumCanvas.width;
  const h = spectrumCanvas.height;

  // Clear
  spectrumCtx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim();
  spectrumCtx.fillRect(0, 0, w, h);

  // Auto-scale using percentile-based approach:
  // The noise floor (median) should sit in the lower part of the colormap,
  // so CW signals pop up into the yellow/white range.
  const sorted = Array.from(mags).filter(v => v > -300 && v < 300).sort((a, b) => a - b);
  const len = sorted.length;
  if (len === 0) return;

  const p10 = sorted[Math.floor(len * 0.10)]; // 10th percentile (band edge rolloff)
  const median = sorted[Math.floor(len * 0.50)]; // noise floor
  const p99 = sorted[Math.floor(len * 0.99)]; // signal peaks

  // Set display range: noise floor in the lower 30% of colormap
  // dbMin = a bit below band edges, dbMax = well above noise to show signals
  const targetMin = p10 - 5;
  const targetMax = Math.max(median + 40, p99 + 10); // at least 40 dB above noise floor

  // Initialize or smooth
  if (autoDbMin === null || !isFinite(autoDbMin)) {
    autoDbMin = targetMin;
    autoDbMax = targetMax;
  } else {
    autoDbMin += (targetMin - autoDbMin) * DB_SMOOTH;
    autoDbMax += (targetMax - autoDbMax) * DB_SMOOTH;
  }

  // Ensure minimum 40 dB range
  if (autoDbMax - autoDbMin < 40) {
    autoDbMax = autoDbMin + 40;
  }

  const dbMin = autoDbMin;
  const dbMax = autoDbMax;
  const dbRange = dbMax - dbMin;

  // Draw grid lines with dB labels
  const gridStep = dbRange > 60 ? 20 : 10;
  const gridStart = Math.ceil(dbMin / gridStep) * gridStep;
  const cs = getComputedStyle(document.documentElement);
  spectrumCtx.strokeStyle = cs.getPropertyValue('--spectrum-grid').trim();
  spectrumCtx.lineWidth = 1;
  spectrumCtx.fillStyle = cs.getPropertyValue('--spectrum-grid-text').trim();
  spectrumCtx.font = '9px monospace';
  for (let db = gridStart; db <= dbMax; db += gridStep) {
    const y = h - ((db - dbMin) / dbRange) * h;
    spectrumCtx.beginPath();
    spectrumCtx.moveTo(0, y);
    spectrumCtx.lineTo(w, y);
    spectrumCtx.stroke();
    spectrumCtx.fillText(`${Math.round(db)} dB`, 3, y - 2);
  }

  // Draw spectrum line
  spectrumCtx.strokeStyle = cs.getPropertyValue('--spectrum-line').trim();
  spectrumCtx.lineWidth = 1;
  spectrumCtx.beginPath();

  for (let i = 0; i < N; i++) {
    const x = (i / N) * w;
    const db = Math.max(dbMin, Math.min(dbMax, mags[i]));
    const y = h - ((db - dbMin) / dbRange) * h;
    if (i === 0) spectrumCtx.moveTo(x, y);
    else spectrumCtx.lineTo(x, y);
  }
  spectrumCtx.stroke();

  // Fill under the curve
  spectrumCtx.lineTo(w, h);
  spectrumCtx.lineTo(0, h);
  spectrumCtx.closePath();
  spectrumCtx.fillStyle = cs.getPropertyValue('--spectrum-fill').trim();
  spectrumCtx.fill();

  // Update label
  const bw = effectiveSampleRate ? (effectiveSampleRate / 1000).toFixed(0) + ' kHz' : '--';
  spectrumLabel.textContent = `BW: ${bw} | FFT: ${data.fftSize || '--'}`;

  // --- Waterfall ---
  renderWaterfallRow(mags, dbMin, dbMax);

  // --- Frequency axis ---
  renderFreqAxis({ ...data, sampleRate: effectiveSampleRate });
}

function renderWaterfallRow(mags, dbMin, dbMax) {
  const w = waterfallCanvas.width;
  const h = waterfallCanvas.height;
  const N = mags.length;

  if (w === 0 || h === 0) return;

  // Scroll existing waterfall down by 1 pixel
  const imageData = waterfallCtx.getImageData(0, 0, w, h - 1);
  waterfallCtx.putImageData(imageData, 0, 1);

  // Draw new row at top
  const row = waterfallCtx.createImageData(w, 1);
  const dbRange = dbMax - dbMin;

  for (let x = 0; x < w; x++) {
    const binIdx = Math.floor((x / w) * N);
    const db = Math.max(dbMin, Math.min(dbMax, mags[binIdx]));
    const normalized = (db - dbMin) / dbRange; // 0..1

    // Color map: theme-dependent
    let r, g, b;
    if (isLightTheme()) {
      // Light: white → light blue → blue → dark blue → black
      if (normalized < 0.25) {
        const t = normalized / 0.25;
        r = Math.floor(232 - t * 100); g = Math.floor(236 - t * 100); b = 240;
      } else if (normalized < 0.5) {
        const t = (normalized - 0.25) / 0.25;
        r = Math.floor(132 - t * 100); g = Math.floor(136 - t * 80); b = Math.floor(240 - t * 40);
      } else if (normalized < 0.75) {
        const t = (normalized - 0.5) / 0.25;
        r = Math.floor(32 + t * 180); g = Math.floor(56 * (1 - t)); b = Math.floor(200 - t * 100);
      } else {
        const t = (normalized - 0.75) / 0.25;
        r = Math.floor(212 + t * 43); g = Math.floor(t * 60); b = Math.floor(100 - t * 100);
      }
    } else {
      // Dark: black → blue → cyan → yellow → white
      if (normalized < 0.25) {
        const t = normalized / 0.25;
        r = 0; g = 0; b = Math.floor(t * 180);
      } else if (normalized < 0.5) {
        const t = (normalized - 0.25) / 0.25;
        r = 0; g = Math.floor(t * 200); b = 180;
      } else if (normalized < 0.75) {
        const t = (normalized - 0.5) / 0.25;
        r = Math.floor(t * 255); g = 200 + Math.floor(t * 55); b = Math.floor(180 * (1 - t));
      } else {
        const t = (normalized - 0.75) / 0.25;
        r = 255; g = 255; b = Math.floor(t * 255);
      }
    }

    const idx = x * 4;
    row.data[idx] = r;
    row.data[idx + 1] = g;
    row.data[idx + 2] = b;
    row.data[idx + 3] = 255;
  }

  waterfallCtx.putImageData(row, 0, 0);
}

function renderFreqAxis(data) {
  if (!data || !data.sampleRate) return;
  const axis = freqAxis;
  const w = axis.clientWidth;
  const halfBw = data.sampleRate / 2;

  // Create frequency labels
  axis.innerHTML = '';
  const numLabels = 10;
  for (let i = 0; i <= numLabels; i++) {
    const frac = i / numLabels;
    const freqOffset = (frac - 0.5) * data.sampleRate;
    const label = document.createElement('span');
    label.style.position = 'absolute';
    label.style.left = (frac * 100) + '%';
    label.style.transform = 'translateX(-50%)';
    label.style.fontSize = '9px';
    label.style.color = 'var(--text-dim)';
    label.style.top = '3px';

    if (Math.abs(freqOffset) < 100) {
      label.textContent = '0';
    } else {
      label.textContent = (freqOffset / 1000).toFixed(1) + 'k';
    }
    axis.appendChild(label);
  }
}

// --- Signals table ---
function addSpotRow(spot) {
  const tr = document.createElement('tr');
  tr.className = 'new-spot';

  const freqKhz = spot.freqKhz || (spot.freqMHz * 1000);

  tr.innerHTML = `
    <td class="freq-cell">${freqKhz.toFixed(1)}</td>
    <td class="call-cell">${escapeHtml(spot.callsign)}</td>
    <td class="entity-cell">${escapeHtml(spot.entity || '')}</td>
    <td class="snr-cell">${spot.snr || 0} dB</td>
    <td class="wpm-cell">${spot.wpm || '?'}</td>
    <td>${escapeHtml(spot.type || '')}</td>
    <td class="text-cell" title="${escapeHtml(spot.text || '')}">${escapeHtml((spot.text || '').slice(-60))}</td>
    <td class="time-cell">${formatTime(spot.time)}</td>
  `;

  // Insert at top
  if (spotsBody.firstChild) {
    spotsBody.insertBefore(tr, spotsBody.firstChild);
  } else {
    spotsBody.appendChild(tr);
  }

  // Limit table size
  while (spotsBody.children.length > 500) {
    spotsBody.removeChild(spotsBody.lastChild);
  }

  spots.unshift(spot);
  if (spots.length > 500) spots.pop();

  spotStats.textContent = `${spots.length} spots`;
  spotTotal.textContent = `Total: ${spots.length}`;
}

// --- Active decoders ---
function updateDecoders() {
  decodersList.innerHTML = '';

  // Sort by frequency offset
  const sorted = Array.from(activeDecoders.entries()).sort((a, b) => a[0] - b[0]);

  for (const [freq, info] of sorted) {
    const div = document.createElement('div');
    div.className = 'decoder-item';
    div.innerHTML = `
      <span class="decoder-freq">${(freq >= 0 ? '+' : '')}${freq.toFixed(0)} Hz</span>
      <span class="decoder-wpm">${info.wpm || '?'} WPM</span>
      <div class="decoder-text">${escapeHtml(info.text || '').slice(-80)}</div>
    `;
    decodersList.appendChild(div);
  }
}

// --- Status updates ---
function updateStatus(status) {
  setDot(radioDot, status.radioConnected);
  setDot(rbnDot, status.rbnConnected);
  setDot(clusterDot, status.dxClusterConnected);
  setDot(dspDot, status.dspWorkerReady);

  radioLabel.textContent = status.radioConnected ? 'Radio' : 'Radio (offline)';

  const rate = status.sampleRate ? (status.sampleRate / 1000).toFixed(0) + ' kHz' : '--';
  iqInfo.textContent = `IQ: ${rate} ch${status.daxIqChannel || '?'}`;

  statusText.textContent = status.streamActive ? 'Receiving IQ data' :
    (status.radioConnected ? 'Connected, waiting for IQ stream' : 'Disconnected');
}

function setDot(el, connected) {
  el.classList.toggle('connected', !!connected);
  el.classList.toggle('disconnected', !connected);
}

// --- Settings ---
async function loadSettingsUi() {
  settings = await window.api.getSettings();
  if (!settings) settings = {};

  document.getElementById('set-radio-host').value = settings.radioHost || '127.0.0.1';
  document.getElementById('set-radio-port').value = settings.radioPort || 4992;
  document.getElementById('set-dax-channel').value = settings.daxIqChannel || 1;
  document.getElementById('set-sample-rate').value = settings.sampleRate || 192000;
  document.getElementById('set-callsign').value = settings.myCallsign || '';
  document.getElementById('set-grid').value = settings.grid || '';
  document.getElementById('set-rbn-enabled').checked = !!settings.rbnEnabled;
  document.getElementById('set-rbn-host').value = settings.rbnHost || 'arcluster.reversebeacon.net';
  document.getElementById('set-rbn-port').value = settings.rbnPort || 7000;
  document.getElementById('set-cluster-enabled').checked = !!settings.dxClusterEnabled;
  document.getElementById('set-cluster-host').value = settings.dxClusterHost || '';
  document.getElementById('set-cluster-port').value = settings.dxClusterPort || 7373;
  document.getElementById('set-sdr-spots').checked = settings.smartSdrSpotsEnabled !== false;
  document.getElementById('set-threshold').value = settings.detectionThreshold || 6;
  document.getElementById('set-min-wpm').value = settings.minWpm || 8;
  document.getElementById('set-max-wpm').value = settings.maxWpm || 60;
  document.getElementById('set-light-mode').checked = !!settings.lightMode;
}

async function saveSettingsUi() {
  const newSettings = {
    // Preserve non-UI keys (betaId, telemetryNoticeSeen, etc.)
    ...settings,
    radioHost: document.getElementById('set-radio-host').value.trim(),
    radioPort: parseInt(document.getElementById('set-radio-port').value) || 4992,
    daxIqChannel: parseInt(document.getElementById('set-dax-channel').value),
    sampleRate: parseInt(document.getElementById('set-sample-rate').value),
    myCallsign: document.getElementById('set-callsign').value.trim().toUpperCase(),
    grid: document.getElementById('set-grid').value.trim(),
    rbnEnabled: document.getElementById('set-rbn-enabled').checked,
    rbnHost: document.getElementById('set-rbn-host').value.trim(),
    rbnPort: parseInt(document.getElementById('set-rbn-port').value) || 7000,
    dxClusterEnabled: document.getElementById('set-cluster-enabled').checked,
    dxClusterHost: document.getElementById('set-cluster-host').value.trim(),
    dxClusterPort: parseInt(document.getElementById('set-cluster-port').value) || 7373,
    smartSdrSpotsEnabled: document.getElementById('set-sdr-spots').checked,
    detectionThreshold: parseInt(document.getElementById('set-threshold').value) || 6,
    minWpm: parseInt(document.getElementById('set-min-wpm').value) || 8,
    maxWpm: parseInt(document.getElementById('set-max-wpm').value) || 60,
    lightMode: document.getElementById('set-light-mode').checked,
  };

  await window.api.saveSettings(newSettings);
  settings = newSettings;

  // Apply theme and sync header toggle
  applyTheme(newSettings.lightMode);
  document.getElementById('theme-toggle').checked = !!newSettings.lightMode;

  settingsOverlay.classList.remove('open');
}

settingsBtn.addEventListener('click', () => {
  loadSettingsUi();
  settingsOverlay.classList.add('open');
});

settingsCancel.addEventListener('click', () => {
  // Revert theme if changed in settings but not saved
  applyTheme(!!settings.lightMode);
  document.getElementById('theme-toggle').checked = !!settings.lightMode;
  settingsOverlay.classList.remove('open');
});

settingsSave.addEventListener('click', saveSettingsUi);

// Close overlay on background click
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) {
    applyTheme(!!settings.lightMode);
    document.getElementById('theme-toggle').checked = !!settings.lightMode;
    settingsOverlay.classList.remove('open');
  }
});

// --- Mode toggle (Skimmer / Reader) ---
// Reader mode zoom: show ±READER_ZOOM_HZ around center instead of full bandwidth
const READER_ZOOM_HZ = 5000; // ±5 kHz

function setDecodeMode(mode) {
  currentMode = mode;
  modeToggle.checked = mode === 'reader';

  // Clear waterfall when switching modes (zoom level changes)
  try { waterfallCtx.clearRect(0, 0, waterfallCanvas.width, waterfallCanvas.height); } catch {}

  if (mode === 'reader') {
    bottomContent.style.display = 'none';
    readerPanel.style.display = 'flex';
    readerText.textContent = '';
    readerWpm.textContent = '-- WPM';
    readerFreqEl.textContent = sliceFreqMHz > 0
      ? (sliceFreqMHz * 1000).toFixed(1) + ' kHz'
      : '--';
  } else {
    readerPanel.style.display = 'none';
    bottomContent.style.display = 'flex';
    activeDecoders.clear();
    updateDecoders();
  }

  window.api.setDecodeMode(mode);
}

modeToggle.addEventListener('change', (e) => {
  setDecodeMode(e.target.checked ? 'reader' : 'skimmer');
});

// --- Theme toggle (header) ---
document.getElementById('theme-toggle').addEventListener('change', async (e) => {
  const light = e.target.checked;
  applyTheme(light);
  settings.lightMode = light;
  await window.api.saveSettings(settings);
});

// --- Settings footer links ---
document.getElementById('coffee-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://buymeacoffee.com/potacat');
});
document.getElementById('discord-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://discord.gg/JjdKSshej');
});
document.getElementById('issues-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://discord.gg/JjdKSshej');
});
document.getElementById('check-update-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.checkForUpdates();
  settingsOverlay.classList.remove('open');
});

// --- Helpers ---
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// --- IPC event handlers ---
window.api.onStatus(updateStatus);

window.api.onSpectrum((data) => {
  spectrumData = data;
  renderSpectrum(data);
});

window.api.onSignals((signals) => {
  signalsCount.textContent = `Signals: ${signals.length}`;
});

window.api.onDecode((data) => {
  if (currentMode === 'reader') {
    // Reader mode: show decoded text in the reader panel
    readerText.textContent = data.text || '';
    if (data.wpm) readerWpm.textContent = `${data.wpm} WPM`;
    // Auto-scroll to bottom
    const container = readerText.parentElement;
    container.scrollTop = container.scrollHeight;
    return;
  }
  // Skimmer mode: update active decoders display
  const key = Math.round(data.freqOffset);
  activeDecoders.set(key, {
    text: data.text,
    wpm: data.wpm,
    snr: data.snr,
    lastUpdate: Date.now(),
  });
  updateDecoders();
});

// Prune stale decoders every 10 seconds (channels evicted in worker won't send further updates)
setInterval(() => {
  const cutoff = Date.now() - 60000;
  let pruned = false;
  for (const [key, info] of activeDecoders) {
    if (info.lastUpdate < cutoff) {
      activeDecoders.delete(key);
      pruned = true;
    }
  }
  if (pruned) updateDecoders();
}, 10000);

window.api.onNewSpot((spot) => {
  addSpotRow(spot);
});

window.api.onRbnStatus((s) => {
  setDot(rbnDot, s.connected);
});

window.api.onClusterStatus((s) => {
  setDot(clusterDot, s.connected);
});

window.api.onSliceUpdate((slice) => {
  const freq = parseFloat(slice.RF_frequency || 0);
  if (freq > 0) {
    sliceFreqMHz = freq;
    if (currentMode === 'reader') {
      readerFreqEl.textContent = (freq * 1000).toFixed(1) + ' kHz';
    }
  }
});

// --- Auto-update UI ---
(function setupUpdateBanner() {
  const banner = document.getElementById('update-banner');
  const message = document.getElementById('update-message');
  const progress = document.getElementById('update-progress');
  const progressFill = document.getElementById('update-progress-fill');
  const progressText = document.getElementById('update-progress-text');
  const downloadBtn = document.getElementById('update-download-btn');
  const releaseLink = document.getElementById('update-release-link');
  const installBtn = document.getElementById('update-install-btn');
  const dismissBtn = document.getElementById('update-dismiss-btn');

  let isUpdaterActive = true; // assume installed build until told otherwise

  window.api.onUpdaterActive((active) => {
    isUpdaterActive = active;
  });

  window.api.onUpdateAvailable((info) => {
    banner.style.display = 'flex';
    progress.style.display = 'none';
    installBtn.style.display = 'none';
    message.textContent = `Update available: v${info.version}`;

    if (isUpdaterActive) {
      downloadBtn.style.display = '';
      releaseLink.style.display = 'none';
    } else {
      // Portable build — link to release page
      downloadBtn.style.display = 'none';
      releaseLink.style.display = '';
      releaseLink.href = info.url || '#';
      releaseLink.textContent = 'View Release';
    }
  });

  window.api.onDownloadProgress((data) => {
    downloadBtn.style.display = 'none';
    progress.style.display = 'flex';
    progressFill.style.width = data.percent + '%';
    progressText.textContent = data.percent + '%';
  });

  window.api.onUpdateDownloaded(() => {
    progress.style.display = 'none';
    downloadBtn.style.display = 'none';
    installBtn.style.display = '';
    message.textContent = 'Update downloaded — restart to install';
  });

  window.api.onUpdateUpToDate(() => {
    // Brief flash, then hide
    banner.style.display = 'flex';
    message.textContent = 'CW CAT is up to date';
    downloadBtn.style.display = 'none';
    releaseLink.style.display = 'none';
    installBtn.style.display = 'none';
    progress.style.display = 'none';
    setTimeout(() => { banner.style.display = 'none'; }, 3000);
  });

  window.api.onUpdateError((msg) => {
    banner.style.display = 'flex';
    progress.style.display = 'none';
    downloadBtn.style.display = 'none';
    releaseLink.style.display = 'none';
    installBtn.style.display = 'none';
    message.textContent = 'Update error: ' + msg;
  });

  downloadBtn.addEventListener('click', () => {
    window.api.startDownload();
    downloadBtn.style.display = 'none';
    progress.style.display = 'flex';
    progressFill.style.width = '0%';
    progressText.textContent = '0%';
  });

  installBtn.addEventListener('click', () => {
    window.api.installUpdate();
  });

  dismissBtn.addEventListener('click', () => {
    banner.style.display = 'none';
  });
})();

// --- Telemetry notice banner ---
(function setupTelemetryBanner() {
  const banner = document.getElementById('telemetry-banner');
  const okBtn = document.getElementById('telemetry-ok-btn');

  okBtn.addEventListener('click', async () => {
    banner.style.display = 'none';
    const s = await window.api.getSettings();
    s.telemetryNoticeSeen = true;
    await window.api.saveSettings(s);
    settings = s;
  });
})();

// --- Titlebar controls ---
document.getElementById('tb-min').addEventListener('click', () => window.api.minimize());
document.getElementById('tb-max').addEventListener('click', () => window.api.maximize());
document.getElementById('tb-close').addEventListener('click', () => window.api.close());

// --- Initialization ---
async function init() {
  settings = await window.api.getSettings();

  // Apply saved theme
  applyTheme(!!settings.lightMode);
  document.getElementById('theme-toggle').checked = !!settings.lightMode;

  // Restore decode mode
  const savedMode = settings.decodeMode || 'skimmer';
  currentMode = savedMode;
  modeToggle.checked = savedMode === 'reader';
  if (savedMode === 'reader') {
    bottomContent.style.display = 'none';
    readerPanel.style.display = 'flex';
  }

  const status = await window.api.getStatus();
  if (status) updateStatus(status);

  // Show telemetry notice banner on first launch
  if (!settings.telemetryNoticeSeen) {
    document.getElementById('telemetry-banner').style.display = 'flex';
  }
}

init();
