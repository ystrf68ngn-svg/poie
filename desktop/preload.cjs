const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tongpinDesktop', {
  preview: source => ipcRenderer.invoke('desktop:preview', source),
  releasePreview: url => ipcRenderer.invoke('desktop:release-preview', url),
  createPdf: (html, title, jobId) => ipcRenderer.invoke('desktop:create-pdf', html, title, jobId),
  cancelPdf: id => ipcRenderer.invoke('desktop:cancel-pdf', id),
  saveDeliverable: (id, filename) => ipcRenderer.invoke('desktop:save-deliverable', id, filename),
  info: () => ipcRenderer.invoke('desktop:info'),
  prepare: kind => ipcRenderer.invoke('desktop:prepare', kind),
  login: provider => ipcRenderer.invoke('desktop:login', provider),
  submitCode: (provider, code) => ipcRenderer.invoke('desktop:code', provider, code),
  cancelLogin: provider => ipcRenderer.invoke('desktop:cancel-login', provider),
  openData: () => ipcRenderer.invoke('desktop:open-data'),
  loadSecrets: () => ipcRenderer.invoke('desktop:load-secrets'),
  saveSecrets: value => ipcRenderer.invoke('desktop:save-secrets', value),
  onTask: listener => { const handler = (_event, data) => listener(data); ipcRenderer.on('desktop:task', handler); return () => ipcRenderer.removeListener('desktop:task', handler); },
});
