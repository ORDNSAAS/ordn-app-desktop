const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ordnDesktop', {
  isDesktop:     true,
  print:         (job)    => ipcRenderer.invoke('ordn-print', job),
  getConfig:     ()       => ipcRenderer.invoke('ordn-get-config'),
  saveConfig:    (config) => ipcRenderer.invoke('ordn-save-config', config),
  syncImpresoras:  (data)   => ipcRenderer.invoke('ordn-sync-impresoras', data),
  installUpdate:   ()       => ipcRenderer.invoke('ordn-install-update'),
  listarImpresorasWindows: () => ipcRenderer.invoke('ordn-listar-impresoras-windows'),
})
