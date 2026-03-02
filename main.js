const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const dgram = require('dgram');

// Prevent EPIPE crashes when stdout/stderr pipe is closed
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});

const { autoUpdater } = require('electron-updater');
const { SmartSdrClient } = require('./lib/smartsdr');
const { RbnClient } = require('./lib/rbn');
const { DxClusterClient } = require('./lib/dxcluster');
const { SpotReporter } = require('./lib/spot-reporter');
const { VitaReceiver } = require('./lib/vita49');
const { IqRingBuffer } = require('./lib/iq-buffer');
const { loadCtyDat, resolveCallsign } = require('./lib/cty');
const { freqToBand } = require('./lib/bands');
const { TelemetryClient } = require('./lib/telemetry');

// --- cty.dat database ---
let ctyDb = null;

// --- Settings ---
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  radioHost: '127.0.0.1',
  radioPort: 4992,
  daxIqChannel: 1,
  sampleRate: 192000,
  myCallsign: '',
  grid: '',
  rbnEnabled: false,
  rbnHost: 'arcluster.reversebeacon.net',
  rbnPort: 7000,
  dxClusterEnabled: false,
  dxClusterHost: '',
  dxClusterPort: 7373,
  smartSdrSpotsEnabled: true,
  detectionThreshold: 6,
  minWpm: 8,
  maxWpm: 60,
};

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

let settings = null;
let win = null;

// --- Clients ---
let smartSdr = null;
let rbn = null;
let dxCluster = null;
let spotReporter = null;
let vitaReceiver = null;
let iqBuffer = null;
let telemetry = null;
let vitaDiagTimer = null;
let dspWorker = null;
let dspWorkerReady = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1a2e',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'CW CAT',
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('closed', () => {
    win = null;
  });
}

// --- DSP Worker management ---

function startDspWorker() {
  if (dspWorker) return;

  dspWorker = new Worker(path.join(__dirname, 'worker', 'dsp-worker.js'));
  dspWorkerReady = false;

  dspWorker.on('message', (msg) => {
    switch (msg.type) {
      case 'ready':
        dspWorkerReady = true;
        console.log('[DSP] Worker ready');
        break;

      case 'spectrum':
        // Forward FFT spectrum data to renderer for waterfall display
        if (win && !win.isDestroyed()) {
          win.webContents.send('spectrum', msg.data);
        }
        break;

      case 'signals':
        // Detected signals with frequency and magnitude
        if (win && !win.isDestroyed()) {
          win.webContents.send('signals', msg.data);
        }
        break;

      case 'decode':
        // Decoded CW text from a channel
        if (win && !win.isDestroyed()) {
          win.webContents.send('decode', msg.data);
        }
        break;

      case 'spot':
        // Callsign extracted — submit as spot
        handleDecodedSpot(msg.data);
        break;

      case 'channel-created':
        if (telemetry) telemetry.recordChannelCreated();
        break;

      case 'channel-evicted':
        if (telemetry) telemetry.recordChannelEvicted();
        break;

      case 'channel-count':
        if (telemetry) telemetry.updateChannelPeak(msg.count);
        break;
    }
  });

  dspWorker.on('error', (err) => {
    console.error('[DSP] Worker error:', err);
    dspWorkerReady = false;
  });

  dspWorker.on('exit', (code) => {
    console.log(`[DSP] Worker exited with code ${code}`);
    dspWorker = null;
    dspWorkerReady = false;
  });
}

function stopDspWorker() {
  if (dspWorker) {
    dspWorker.postMessage({ type: 'stop' });
    dspWorker.terminate();
    dspWorker = null;
    dspWorkerReady = false;
  }
}

function sendToDspWorker(msg, transferList) {
  if (dspWorker && dspWorkerReady) {
    if (transferList) {
      dspWorker.postMessage(msg, transferList);
    } else {
      dspWorker.postMessage(msg);
    }
  }
}

// --- VITA-49 / IQ data pipeline ---

function stopIqPipeline() {
  if (vitaDiagTimer) {
    clearInterval(vitaDiagTimer);
    vitaDiagTimer = null;
  }
  if (vitaReceiver) {
    vitaReceiver.stop();
    vitaReceiver = null;
  }
  iqBuffer = null;
}

// --- Spot handling ---

function handleDecodedSpot(data) {
  if (!settings || !data.callsign) return;

  // Compute absolute frequency: slice center + offset from DSP
  let centerMHz = 0;
  if (smartSdr) {
    centerMHz = smartSdr.getSliceFreq(0); // Use first slice as reference
  }
  const freqMHz = centerMHz + (data.freqOffset || 0) / 1e6;
  const freqKhz = freqMHz * 1000;
  const band = freqToBand(freqMHz);

  // Validate callsign against cty.dat
  const entity = ctyDb ? resolveCallsign(data.callsign, ctyDb) : null;

  const comment = `CW ${data.snr || 0} dB ${data.wpm || 0} WPM${data.type ? ' ' + data.type : ''}`;

  const spot = {
    callsign: data.callsign,
    freqMHz,
    freqKhz,
    band,
    snr: data.snr || 0,
    wpm: data.wpm || 0,
    type: data.type || '',
    comment,
    entity: entity ? entity.name : '',
    continent: entity ? entity.continent : '',
    text: data.text || '',
    time: new Date().toISOString(),
  };

  console.log(`[SPOT] ${spot.callsign} @ ${freqKhz.toFixed(1)} kHz (${spot.band || '?'}) ${spot.entity} — ${spot.comment} — "${(spot.text || '').slice(-40)}"`);

  // Record to telemetry
  if (telemetry) telemetry.recordSpot(spot);

  // Submit to all outputs via SpotReporter
  if (spotReporter) {
    spotReporter.submit(spot);
  }

  // Send to renderer
  if (win && !win.isDestroyed()) {
    win.webContents.send('new-spot', spot);
  }
}

// --- Radio connection ---

function connectRadio() {
  if (!settings || !settings.radioHost) return;

  // Start VITA-49 UDP receiver first to get a port number
  stopIqPipeline();
  const sampleRate = settings.sampleRate || 192000;
  const blockSize = 4096;

  iqBuffer = new IqRingBuffer(sampleRate * 2, blockSize);

  sendToDspWorker({
    type: 'configure',
    sampleRate,
    fftSize: blockSize,
    threshold: settings.detectionThreshold || 6,
    minWpm: settings.minWpm || 8,
    maxWpm: settings.maxWpm || 60,
    ctyDatPath: path.join(__dirname, 'assets', 'cty.dat'),
  });

  vitaReceiver = new VitaReceiver(7791);

  let vitaPacketCount = 0;
  let vitaIqSamples = 0;
  let vitaBlocksSent = 0;

  vitaReceiver.on('iq-data', (samples) => {
    vitaPacketCount++;
    vitaIqSamples += samples.length;
    const blocks = iqBuffer.write(samples);
    vitaBlocksSent += blocks.length;
    for (const block of blocks) {
      sendToDspWorker({
        type: 'iq-block',
        block: block.buffer,
      }, [block.buffer]);
    }
  });

  // Log first few raw UDP packets for debugging
  let rawPacketLog = 0;
  const origParse = vitaReceiver._parsePacket.bind(vitaReceiver);
  vitaReceiver._parsePacket = function(buf) {
    if (rawPacketLog < 3) {
      rawPacketLog++;
      const word0 = buf.readUInt32BE(0);
      const pktType = (word0 >>> 28) & 0x0F;
      const streamId = buf.length >= 8 ? buf.readUInt32BE(4) : 0;
      console.log(`[VITA-49] Raw packet #${rawPacketLog}: len=${buf.length}, type=0x${pktType.toString(16)}, streamId=0x${streamId.toString(16).padStart(8, '0')}, word0=0x${word0.toString(16).padStart(8, '0')}`);
    }
    origParse(buf);
  };

  // Periodic diagnostics
  vitaDiagTimer = setInterval(() => {
    if (vitaPacketCount > 0) {
      const stats = vitaReceiver.getStats();
      console.log(`[VITA-49] pkts=${stats.received}, iq_samples=${vitaIqSamples}, blocks_to_dsp=${vitaBlocksSent}, dropped=${stats.dropped}`);
      if (telemetry) telemetry.updatePacketStats(stats.received, stats.dropped);
      vitaPacketCount = 0;
      vitaIqSamples = 0;
      vitaBlocksSent = 0;
    }
  }, 5000);

  vitaReceiver.on('error', (err) => {
    console.error('[VITA-49] Error:', err);
  });

  vitaReceiver.on('listening', (udpPort) => {
    console.log(`[IQ] VITA-49 receiver ready on UDP port ${udpPort}`);

    // Now connect to radio with our UDP port
    smartSdr = new SmartSdrClient();
    smartSdr.setUdpPort(udpPort);

    smartSdr.on('connected', () => {
      console.log('[Radio] Connected to SmartSDR');
      sendStatus();

      // Wait briefly for subscription status messages to arrive (slices, pans)
      // before creating the DAX IQ stream
      setTimeout(() => {
        const channel = settings.daxIqChannel || 1;
        const rate = settings.sampleRate || 192000;

        // Assign DAX IQ channel to the first panadapter
        const panId = smartSdr.getFirstPanadapterId();
        if (panId) {
          smartSdr.setPanDaxIq(panId, channel);
        } else {
          console.log('[Radio] WARNING: No panadapter found — DAX IQ may not flow. Assign DAX IQ channel in SmartSDR.');
        }

        // Log known state
        console.log(`[Radio] Known panadapters: ${Array.from(smartSdr._panadapters.keys()).join(', ') || 'none'}`);
        console.log(`[Radio] Known slices: ${Array.from(smartSdr._slices.keys()).join(', ') || 'none'}`);

        smartSdr.createDaxIqStream(channel, rate, (err, streamId) => {
          if (err) {
            console.error('[Radio] Failed to create DAX IQ stream:', err);
          } else {
            console.log(`[Radio] DAX IQ stream active: ${streamId}, rate=${rate}`);
          }
          sendStatus();
        });
      }, 1500);
    });

    smartSdr.on('disconnected', () => {
      console.log('[Radio] Disconnected');
      sendStatus();
    });

    smartSdr.on('error', (err) => {
      console.error('[Radio] Error:', err.message);
    });

    let lastSentCenterMHz = 0;
    smartSdr.on('slice', (slice) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('slice-update', slice);
      }
      // Forward center frequency to DSP worker — only when RF frequency actually changes
      const centerMHz = smartSdr.getSliceFreq(0);
      if (centerMHz > 0 && centerMHz !== lastSentCenterMHz) {
        lastSentCenterMHz = centerMHz;
        sendToDspWorker({ type: 'set-center-freq', centerMHz });
      }
    });

    smartSdr.connect(settings.radioHost, settings.radioPort);
  });

  vitaReceiver.start();
}

function disconnectRadio() {
  stopIqPipeline();
  if (smartSdr) {
    smartSdr.disconnect();
    smartSdr = null;
  }
}

// --- Spot outputs ---

function connectOutputs() {
  if (!settings) return;

  spotReporter = new SpotReporter(settings.myCallsign);

  // RBN
  if (settings.rbnEnabled && settings.myCallsign) {
    rbn = new RbnClient();
    rbn.on('status', (s) => {
      if (win && !win.isDestroyed()) win.webContents.send('rbn-status', s);
    });
    rbn.connect({
      host: settings.rbnHost,
      port: settings.rbnPort,
      callsign: settings.myCallsign,
    });
    spotReporter.setRbn(rbn);
  }

  // DX Cluster
  if (settings.dxClusterEnabled && settings.dxClusterHost && settings.myCallsign) {
    dxCluster = new DxClusterClient();
    dxCluster.on('status', (s) => {
      if (win && !win.isDestroyed()) win.webContents.send('cluster-status', s);
    });
    dxCluster.connect({
      host: settings.dxClusterHost,
      port: settings.dxClusterPort,
      callsign: settings.myCallsign,
    });
    spotReporter.setDxCluster(dxCluster);
  }

  // SmartSDR spot push
  if (settings.smartSdrSpotsEnabled && smartSdr) {
    spotReporter.setSmartSdr(smartSdr);
  }
}

function disconnectOutputs() {
  if (rbn) { rbn.disconnect(); rbn = null; }
  if (dxCluster) { dxCluster.disconnect(); dxCluster = null; }
  spotReporter = null;
}

// --- Status ---

function sendStatus() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('status', {
    radioConnected: smartSdr ? smartSdr.connected : false,
    rbnConnected: rbn ? rbn.connected : false,
    dxClusterConnected: dxCluster ? dxCluster.connected : false,
    dspWorkerReady,
    sampleRate: settings ? settings.sampleRate : 0,
    daxIqChannel: settings ? settings.daxIqChannel : 0,
    streamActive: vitaReceiver != null,
  });
}

// --- IPC handlers ---

ipcMain.handle('get-settings', () => settings);

ipcMain.handle('save-settings', (_e, newSettings) => {
  const oldSettings = { ...settings };
  settings = { ...DEFAULT_SETTINGS, ...newSettings };
  saveSettings(settings);

  // Reconnect if radio host changed
  const radioChanged = oldSettings.radioHost !== settings.radioHost ||
    oldSettings.radioPort !== settings.radioPort ||
    oldSettings.daxIqChannel !== settings.daxIqChannel ||
    oldSettings.sampleRate !== settings.sampleRate;

  const outputsChanged = oldSettings.rbnEnabled !== settings.rbnEnabled ||
    oldSettings.rbnHost !== settings.rbnHost ||
    oldSettings.dxClusterEnabled !== settings.dxClusterEnabled ||
    oldSettings.dxClusterHost !== settings.dxClusterHost ||
    oldSettings.myCallsign !== settings.myCallsign ||
    oldSettings.smartSdrSpotsEnabled !== settings.smartSdrSpotsEnabled;

  if (radioChanged) {
    disconnectRadio();
    connectRadio();
  }

  if (outputsChanged) {
    disconnectOutputs();
    connectOutputs();
  }

  // Update telemetry spotter callsign
  if (telemetry) telemetry.setSpotterCall(settings.myCallsign);

  // Update DSP settings
  sendToDspWorker({
    type: 'configure',
    threshold: settings.detectionThreshold,
    minWpm: settings.minWpm,
    maxWpm: settings.maxWpm,
  });

  sendStatus();
  return true;
});

ipcMain.on('connect-radio', () => {
  disconnectRadio();
  connectRadio();
});

ipcMain.on('disconnect-radio', () => {
  disconnectRadio();
  sendStatus();
});

ipcMain.handle('get-status', () => {
  return {
    radioConnected: smartSdr ? smartSdr.connected : false,
    rbnConnected: rbn ? rbn.connected : false,
    dxClusterConnected: dxCluster ? dxCluster.connected : false,
    dspWorkerReady,
    sampleRate: settings ? settings.sampleRate : 0,
    streamActive: vitaReceiver != null,
  };
});

// --- Auto-update (electron-updater for installed, GitHub API fallback for portable) ---

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.allowPrerelease = true;
autoUpdater.logger = {
  info: (...args) => console.log('[updater]', ...args),
  warn: (...args) => console.warn('[updater]', ...args),
  error: (...args) => console.error('[updater]', ...args),
  debug: (...args) => console.log('[updater:debug]', ...args),
};

autoUpdater.on('update-available', (info) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-available', {
      version: info.version,
      releaseName: info.releaseName || '',
      releaseNotes: info.releaseNotes || '',
    });
  }
});

autoUpdater.on('download-progress', (progress) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-download-progress', { percent: Math.round(progress.percent) });
  }
});

autoUpdater.on('update-downloaded', () => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-downloaded');
  }
});

autoUpdater.on('update-not-available', () => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-up-to-date');
  }
});

autoUpdater.on('error', (err) => {
  console.error('autoUpdater error:', err);
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-error', err?.message || String(err));
  }
});

// Open external URLs
ipcMain.on('open-external', (_e, url) => { shell.openExternal(url); });

// Window control IPC
ipcMain.on('win-minimize', () => { if (win) win.minimize(); });
ipcMain.on('win-maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win-close', () => { if (win) win.close(); });

ipcMain.on('start-download', () => { autoUpdater.downloadUpdate(); });
ipcMain.on('install-update', () => { autoUpdater.quitAndInstall(); });
ipcMain.on('check-for-updates', () => { checkForUpdates(); });

function checkForUpdatesManual() {
  const https = require('https');
  const currentVersion = require('./package.json').version;
  const options = {
    hostname: 'api.github.com',
    path: '/repos/Waffleslop/cw-cat/releases',
    headers: { 'User-Agent': 'CW_CAT/' + currentVersion },
    timeout: 10000,
  };
  const req = https.get(options, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        const releases = JSON.parse(body);
        if (!Array.isArray(releases) || releases.length === 0) return;
        // Find the newest release (including pre-releases)
        let newest = null;
        for (const rel of releases) {
          const tag = (rel.tag_name || '').replace(/^v/, '');
          if (!tag) continue;
          if (!newest || isNewerVersion(newest.tag, tag)) {
            newest = { tag, url: rel.html_url, name: rel.name || '' };
          }
        }
        if (newest && isNewerVersion(currentVersion, newest.tag)) {
          if (win && !win.isDestroyed()) {
            win.webContents.send('update-available', { version: newest.tag, url: newest.url, headline: newest.name });
          }
        } else if (win && !win.isDestroyed()) {
          win.webContents.send('update-up-to-date');
        }
      } catch { /* silently ignore parse errors */ }
    });
  });
  req.on('error', () => { /* silently ignore — no internet is fine */ });
}

function isNewerVersion(current, latest) {
  const a = current.split('.').map(Number);
  const b = latest.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (bv > av) return true;
    if (bv < av) return false;
  }
  return false;
}

function checkForUpdates() {
  if (autoUpdater.isUpdaterActive()) {
    autoUpdater.checkForUpdates().catch(() => {});
    if (win && !win.isDestroyed()) {
      win.webContents.send('updater-active', true);
    }
  } else {
    if (win && !win.isDestroyed()) {
      win.webContents.send('updater-active', false);
    }
    checkForUpdatesManual();
  }
}

// --- App lifecycle ---

app.whenReady().then(() => {
  // Load cty.dat
  const ctyPath = path.join(__dirname, 'assets', 'cty.dat');
  if (fs.existsSync(ctyPath)) {
    ctyDb = loadCtyDat(ctyPath);
    console.log(`[CTY] Loaded ${ctyDb.entities.length} entities`);
  }

  settings = loadSettings();

  // Start telemetry
  telemetry = new TelemetryClient({
    settingsPath: SETTINGS_PATH,
    version: require('./package.json').version,
    getUserData: () => app.getPath('userData'),
  });
  telemetry.setSpotterCall(settings.myCallsign);
  telemetry.start();

  // Start DSP worker
  startDspWorker();

  createWindow();

  // Auto-connect on startup
  setTimeout(() => {
    connectRadio();
    connectOutputs();
    sendStatus();
  }, 1000);

  // Check for updates 5 seconds after launch
  setTimeout(() => {
    checkForUpdates();
  }, 5000);
});

app.on('window-all-closed', () => {
  stopDspWorker();
  disconnectRadio();
  disconnectOutputs();
  app.quit();
});

app.on('before-quit', () => {
  if (telemetry) telemetry.stop();
  stopDspWorker();
  disconnectRadio();
  disconnectOutputs();
});
