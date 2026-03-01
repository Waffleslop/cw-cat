const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  getStatus: () => ipcRenderer.invoke('get-status'),

  // Radio control
  connectRadio: () => ipcRenderer.send('connect-radio'),
  disconnectRadio: () => ipcRenderer.send('disconnect-radio'),

  // Events from main process
  onStatus: (cb) => ipcRenderer.on('status', (_e, data) => cb(data)),
  onSpectrum: (cb) => ipcRenderer.on('spectrum', (_e, data) => cb(data)),
  onSignals: (cb) => ipcRenderer.on('signals', (_e, data) => cb(data)),
  onDecode: (cb) => ipcRenderer.on('decode', (_e, data) => cb(data)),
  onNewSpot: (cb) => ipcRenderer.on('new-spot', (_e, data) => cb(data)),
  onSliceUpdate: (cb) => ipcRenderer.on('slice-update', (_e, data) => cb(data)),
  onRbnStatus: (cb) => ipcRenderer.on('rbn-status', (_e, s) => cb(s)),
  onClusterStatus: (cb) => ipcRenderer.on('cluster-status', (_e, s) => cb(s)),
});
