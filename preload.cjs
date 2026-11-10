const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('authgateUpdater', {
  getSavedSettings: () => ipcRenderer.invoke('updater:get-saved-settings'),
  login: (credentials) => ipcRenderer.invoke('updater:login', credentials),
  start: (configuration) => ipcRenderer.invoke('updater:start', configuration),
  stop: () => ipcRenderer.invoke('updater:stop'),
  changeUnit: () => ipcRenderer.invoke('updater:change-unit'),
  openInstanceQr: () => ipcRenderer.invoke('updater:open-instance-qr'),
  updateNow: () => ipcRenderer.invoke('updater:update-now'),
  onAppUpdate: (callback) => ipcRenderer.on('updater:app-update', (_event, state) => callback(state)),
  onLog: (callback) => ipcRenderer.on('updater:log', (_event, entry) => callback(entry)),
  onSession: (callback) => ipcRenderer.on('updater:session', (_event, session) => callback(session)),
  onState: (callback) => ipcRenderer.on('updater:state', (_event, state) => callback(state)),
});
