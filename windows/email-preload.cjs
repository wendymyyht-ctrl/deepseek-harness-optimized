const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('emailSetup', {
  save: account => ipcRenderer.invoke('email-account-save', account),
  close: () => ipcRenderer.send('email-account-close'),
})
