const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  getStatus: () => ipcRenderer.invoke('get-status'),

  // Radio control
  connectRadio: () => ipcRenderer.send('connect-radio'),
  disconnectRadio: () => ipcRenderer.send('disconnect-radio'),

  // Decode mode (skimmer/reader)
  setDecodeMode: (mode) => ipcRenderer.send('set-decode-mode', mode),

  // CWX (CW transmit)
  cwxSend: (text) => ipcRenderer.send('cwx-send', text),
  cwxClear: () => ipcRenderer.send('cwx-clear'),
  readerReset: () => ipcRenderer.send('reader-reset'),

  // Events from main process
  onStatus: (cb) => ipcRenderer.on('status', (_e, data) => cb(data)),
  onSpectrum: (cb) => ipcRenderer.on('spectrum', (_e, data) => cb(data)),
  onSignals: (cb) => ipcRenderer.on('signals', (_e, data) => cb(data)),
  onDecode: (cb) => ipcRenderer.on('decode', (_e, data) => cb(data)),
  onNewSpot: (cb) => ipcRenderer.on('new-spot', (_e, data) => cb(data)),
  onSliceUpdate: (cb) => ipcRenderer.on('slice-update', (_e, data) => cb(data)),
  onPanCenter: (cb) => ipcRenderer.on('pan-center', (_e, freqMHz) => cb(freqMHz)),
  onRbnStatus: (cb) => ipcRenderer.on('rbn-status', (_e, s) => cb(s)),
  onClusterStatus: (cb) => ipcRenderer.on('cluster-status', (_e, s) => cb(s)),
  onCwxBlocked: (cb) => ipcRenderer.on('cwx-blocked', () => cb()),
  onLog: (cb) => ipcRenderer.on('log', (_e, msg) => cb(msg)),

  // Window controls
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),

  // Auto-update
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, d) => cb(d)),
  onUpdaterActive: (cb) => ipcRenderer.on('updater-active', (_e, active) => cb(active)),
  onDownloadProgress: (cb) => ipcRenderer.on('update-download-progress', (_e, d) => cb(d)),
  onUpdateError: (cb) => ipcRenderer.on('update-error', (_e, msg) => cb(msg)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', () => cb()),
  onUpdateUpToDate: (cb) => ipcRenderer.on('update-up-to-date', () => cb()),
  startDownload: () => ipcRenderer.send('start-download'),
  installUpdate: () => ipcRenderer.send('install-update'),
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
});
