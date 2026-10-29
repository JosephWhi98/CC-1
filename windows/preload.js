const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cc1Native', { pickFolder: () => ipcRenderer.invoke('pick-folder'), notify: (title, body) => ipcRenderer.send('notify', { title, body }) });
