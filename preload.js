const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ordnDesktop', {
  isDesktop:     true,
  print:         (job)    => ipcRenderer.invoke('ordn-print', job),
  getConfig:     ()       => ipcRenderer.invoke('ordn-get-config'),
  saveConfig:    (config) => ipcRenderer.invoke('ordn-save-config', config),
  installUpdate: ()       => ipcRenderer.invoke('ordn-install-update'),
})
