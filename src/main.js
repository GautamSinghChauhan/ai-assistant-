require('dotenv').config()

const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const Groq = require('groq-sdk')

const GROQ_API_KEY = process.env.GROQ_API_KEY

console.log('API Key Loaded:', !!GROQ_API_KEY)

// ============================================

let mainWindow
let tray
const groq = new Groq({ apiKey: GROQ_API_KEY })

function applyScreenPrivacy() {
  if (process.platform !== 'win32') return false
  try {
    const koffi = require('koffi')
    const lib = koffi.load('user32.dll')

    const SetWindowDisplayAffinity = lib.func(
      'bool SetWindowDisplayAffinity(void *hWnd, uint32 dwAffinity)'
    )

    const hwndBuffer = mainWindow.getNativeWindowHandle()
    const result = SetWindowDisplayAffinity(
      koffi.decode(hwndBuffer, 'void *'), 
      0x00000011
    )
    console.log('Privacy applied:', result)
    return result
  } catch (err) {
    console.error('Privacy error:', err.message)
    return false
  }
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  mainWindow = new BrowserWindow({
    width: 780,
    height: 640,
    minWidth: 500,
    minHeight: 400,
    frame: false,
    backgroundColor: '#0D1117',
    alwaysOnTop: true,
    x: width - 800,
    y: Math.floor((height - 640) / 2),
    title: 'AI Assistant',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  })

  mainWindow.loadFile(path.join(__dirname, 'index.html'))

// Naya — replace karo iske saath
mainWindow.webContents.session.setPermissionRequestHandler(
  (webContents, permission, callback) => {
    const allowed = [
      'media', 
      'microphone', 
      'audioCapture',
      'speech-recognition',  // ← yeh add kiya
      'notifications'
    ]
    console.log('Permission requested:', permission)
    callback(allowed.includes(permission))
  }
)

mainWindow.webContents.session.setPermissionCheckHandler(
  (webContents, permission, requestingOrigin, details) => {
    const allowed = ['media', 'microphone', 'audioCapture', 'speech-recognition']
    return allowed.includes(permission)
  }
)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    setTimeout(() => applyScreenPrivacy(), 500)
    setTimeout(() => applyScreenPrivacy(), 1500)
    setTimeout(() => applyScreenPrivacy(), 3000)
  })

  mainWindow.on('focus', () => setTimeout(() => applyScreenPrivacy(), 200))
  mainWindow.on('closed', () => { mainWindow = null })
}

function createTray() {
  try { tray = new Tray(nativeImage.createEmpty()) }
  catch { tray = new Tray(nativeImage.createEmpty()) }
  tray.setToolTip('AI Assistant')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide  (Ctrl+H)', click: () => toggleWindow() },
    { label: 'Move to Left',          click: () => moveWindow('left') },
    { label: 'Move to Right',         click: () => moveWindow('right') },
    { label: 'Move to Center',        click: () => moveWindow('center') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]))
  tray.on('click', () => toggleWindow())
}

function toggleWindow() {
  if (!mainWindow) return
  if (mainWindow.isVisible()) {
    mainWindow.hide()
  } else {
    mainWindow.show()
    mainWindow.focus()
    setTimeout(() => applyScreenPrivacy(), 300)
  }
}

function moveWindow(position) {
  if (!mainWindow) return
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const [winW, winH] = mainWindow.getSize()
  const pos = {
    left:   { x: 20,                y: Math.floor((height - winH) / 2) },
    right:  { x: width - winW - 20, y: Math.floor((height - winH) / 2) },
    center: { x: Math.floor((width - winW) / 2), y: Math.floor((height - winH) / 2) }
  }
  if (pos[position]) mainWindow.setPosition(pos[position].x, pos[position].y)
}

app.whenReady().then(() => {
  createWindow()
  createTray()
  globalShortcut.register('CommandOrControl+H', () => toggleWindow())
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
      mainWindow.webContents.send('trigger-voice')
    }
  })
  globalShortcut.register('CommandOrControl+Shift+Left',  () => moveWindow('left'))
  globalShortcut.register('CommandOrControl+Shift+Right', () => moveWindow('right'))
  globalShortcut.register('CommandOrControl+Shift+Down',  () => moveWindow('center'))
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('will-quit', () => globalShortcut.unregisterAll())

ipcMain.handle('ask-ai', async (event, messages) => {
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages,
      max_tokens: 1500,
      temperature: 0.7
    })
    return { success: true, reply: response.choices[0].message.content }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('transcribe-audio', async (event, arrayBuffer, mimeType) => {
  let tempFilePath = null
  try {
    const buffer = Buffer.from(arrayBuffer)
    const tempDir = os.tmpdir()

    // Determine extension from mimeType
    let ext = 'webm'
    if (mimeType) {
      const match = mimeType.match(/audio\/([^;]+)/)
      if (match && match[1]) {
        ext = match[1]
      }
    }

    tempFilePath = path.join(tempDir, `voice-${Date.now()}.${ext}`)
    await fs.promises.writeFile(tempFilePath, buffer)

    const response = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: 'whisper-large-v3',
    })

    return { success: true, text: response.text }
  } catch (err) {
    console.error('Transcription error:', err)
    return { success: false, error: err.message }
  } finally {
    if (tempFilePath) {
      try {
        await fs.promises.unlink(tempFilePath)
      } catch (err) {
        console.error('Failed to delete temp audio file:', err)
      }
    }
  }
})

ipcMain.on('window-minimize',  () => mainWindow?.minimize())
ipcMain.on('window-maximize',  () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize())
ipcMain.on('window-hide',      () => mainWindow?.hide())
ipcMain.on('window-move',      (e, pos) => moveWindow(pos))
ipcMain.on('reapply-privacy',  () => {
  const ok = applyScreenPrivacy()
  mainWindow?.webContents.send('privacy-status', ok)
})