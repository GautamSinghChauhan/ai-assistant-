require('dotenv').config()
const dns = require('dns')

// Force IPv4 resolution first in Node.js to resolve 'fetch failed' errors on Windows/dual-stack networks
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first')
}

const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { GoogleGenerativeAI } = require('@google/generative-ai')

const GEMINI_API_KEY = process.env.GEMINI_API_KEY

console.log('GEMINI API Key Loaded:', !!GEMINI_API_KEY)

// ============================================

let mainWindow
let tray
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null

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

async function callGemini(messages, modelName = 'gemini-3.6-flash') {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY missing in .env file. Please add your GEMINI_API_KEY to the .env file.')
  }
  const client = genAI || new GoogleGenerativeAI(apiKey)

  let systemInstruction = 'Aap ek helpful AI assistant hain. Hindi aur English dono mein jawab dein. Code clear aur concise dein.'
  const contents = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = msg.content
    } else if (msg.role === 'user') {
      contents.push({
        role: 'user',
        parts: [{ text: msg.content }]
      })
    } else if (msg.role === 'assistant' || msg.role === 'model') {
      contents.push({
        role: 'model',
        parts: [{ text: msg.content }]
      })
    }
  }

  if (contents.length === 0) {
    throw new Error('No messages to send.')
  }

  // Model fallback candidate list
  const candidateModels = [
    modelName,
    'gemini-3.6-flash',
    'gemini-2.5-flash',
    'gemini-1.5-flash-latest'
  ]
  const modelsToTry = [...new Set(candidateModels.filter(Boolean))]

  let lastError = null
  for (const targetModel of modelsToTry) {
    try {
      console.log(`Calling Gemini API with model: ${targetModel}`)
      const model = client.getGenerativeModel({
        model: targetModel,
        systemInstruction: systemInstruction
      })

      const result = await model.generateContent({ contents })
      const response = await result.response
      return response.text()
    } catch (err) {
      console.warn(`Gemini model '${targetModel}' failed:`, err.message)
      lastError = err
      // If error is 404 (model not found), try next model in fallback list
      if (err.message.includes('404') || err.message.includes('not found')) {
        continue
      }
      throw err
    }
  }
  throw lastError
}

ipcMain.handle('ask-ai', async (event, messages, options = {}) => {
  const modelName = options.model || 'gemini-3.6-flash'

  try {
    const reply = await callGemini(messages, modelName)
    return { success: true, reply, provider: 'gemini' }
  } catch (err) {
    console.error('AI Processing Error:', err)
    let userMessage = err.message
    if (userMessage.includes('fetch failed')) {
      userMessage = 'Network Error (fetch failed): Unable to reach Google Gemini API servers. Please check your internet connection or turn off active VPN/Proxies if any.'
    } else if (userMessage.includes('429') || userMessage.includes('Quota exceeded')) {
      userMessage = 'Gemini API Quota Exceeded. Please get a free key from https://aistudio.google.com/app/apikey.'
    } else if (userMessage.includes('404') || userMessage.includes('not found')) {
      userMessage = 'Selected model not supported by this API key. Tried fallback models but none were available for your key.'
    }
    return { success: false, error: userMessage }
  }
})

ipcMain.handle('transcribe-audio', async (event, arrayBuffer, mimeType) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY missing in .env file.')

    const client = genAI || new GoogleGenerativeAI(apiKey)
    const base64Audio = Buffer.from(arrayBuffer).toString('base64')
    const modelsToTry = ['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-1.5-flash-latest']

    let lastErr = null
    for (const targetModel of modelsToTry) {
      try {
        const model = client.getGenerativeModel({ model: targetModel })
        const result = await model.generateContent([
          {
            inlineData: {
              mimeType: mimeType || 'audio/webm',
              data: base64Audio
            }
          },
          'Transcribe this audio recording exactly as spoken. Return ONLY the transcribed text without any extra comments.'
        ])

        const response = await result.response
        return { success: true, text: response.text().trim() }
      } catch (err) {
        lastErr = err
        if (err.message.includes('404') || err.message.includes('not found')) continue
        throw err
      }
    }
    throw lastErr
  } catch (err) {
    console.error('Transcription error:', err)
    return { success: false, error: err.message }
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