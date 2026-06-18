const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  askAI:          (messages) => ipcRenderer.invoke('ask-ai', messages),
  onTriggerVoice: (cb) => ipcRenderer.on('trigger-voice', cb),
  transcribeAudio:(arrayBuffer, mimeType) => ipcRenderer.invoke('transcribe-audio', arrayBuffer, mimeType),
  minimize:       () => ipcRenderer.send('window-minimize'),
  maximize:       () => ipcRenderer.send('window-maximize'),
  hide:           () => ipcRenderer.send('window-hide'),
  move:           (pos) => ipcRenderer.send('window-move', pos),
  reapplyPrivacy: () => ipcRenderer.send('reapply-privacy'),
})
