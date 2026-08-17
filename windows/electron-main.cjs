const { app, BrowserWindow, shell } = require('electron')
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

const APP_NAME = 'DeepSeek Harness Optimized'
const URL_PATTERN = /http:\/\/(?:127\.0\.0\.1|localhost):[0-9]+/u
const MAX_RECENT_LINES = 24

let mainWindow
let harnessProcess
let serverOrigin
let outputBuffer = ''
let recentOutput = []
let shuttingDown = false

function escapeHTML(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function statusDocument(title, detail) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHTML(title)}</title><style>
:root{color-scheme:dark;font-family:Segoe UI,system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;color:#f7f9ff}
main{max-width:620px;padding:48px;text-align:center}.mark{width:72px;height:72px;margin:auto;border-radius:20px;display:grid;place-items:center;background:linear-gradient(145deg,#3078ff,#8d5cff);font:700 27px Consolas,monospace;box-shadow:0 18px 50px #0008}
h1{margin:24px 0 10px;font-size:26px}p{color:#b8c2dc;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
</style></head><body><main><div class="mark">H&lt;/&gt;</div><h1>${escapeHTML(title)}</h1><p>${escapeHTML(detail)}</p></main></body></html>`
}

function showStatus(title, detail) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const document = statusDocument(title, detail)
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`)
}

function applicationRoot() {
  if (process.env.DSH_PACKAGED_APP_ROOT?.trim()) return resolve(process.env.DSH_PACKAGED_APP_ROOT)
  return app.isPackaged ? join(process.resourcesPath, 'app') : resolve(__dirname, '..')
}

function isHarnessURL(candidate) {
  if (!serverOrigin) return false
  try {
    return new URL(candidate).origin === serverOrigin
  } catch {
    return false
  }
}

function openExternal(candidate) {
  try {
    const url = new URL(candidate)
    if (url.protocol === 'http:' || url.protocol === 'https:') void shell.openExternal(url.href)
  } catch {}
}

function configureNavigation(window) {
  window.webContents.on('will-navigate', (event, candidate) => {
    if (isHarnessURL(candidate) || candidate.startsWith('data:text/html')) return
    event.preventDefault()
    openExternal(candidate)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isHarnessURL(url)) return { action: 'allow' }
    openExternal(url)
    return { action: 'deny' }
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  configureNavigation(mainWindow)
  mainWindow.once('ready-to-show', () => mainWindow.show())
  showStatus('Starting DeepSeek Harness…', 'Preparing the local runtime. Your credentials and conversations stay on this PC.')
}

function consumeOutput(text) {
  outputBuffer += text
  const lines = outputBuffer.split(/\r?\n/u)
  outputBuffer = lines.pop() || ''
  for (const line of lines) {
    if (!line) continue
    recentOutput.push(line)
    recentOutput = recentOutput.slice(-MAX_RECENT_LINES)
    if (serverOrigin) continue
    const match = line.match(URL_PATTERN)
    if (!match) continue
    serverOrigin = new URL(match[0]).origin
    mainWindow.setTitle(APP_NAME)
    void mainWindow.loadURL(match[0])
  }
}

function startHarness() {
  const root = applicationRoot()
  const server = join(root, 'scripts', 'app-server.mjs')
  if (!existsSync(server)) {
    showStatus('Unable to start', 'The bundled Harness files are incomplete. Download the application again.')
    return
  }
  const environment = {
    ...process.env,
    DSH_HOME: process.env.DSH_HOME?.trim() || app.getPath('userData'),
    DSH_APP_MODE: '1',
    ELECTRON_RUN_AS_NODE: '1',
  }
  harnessProcess = spawn(process.execPath, [server], {
    cwd: root,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  harnessProcess.stdout.on('data', chunk => consumeOutput(chunk.toString('utf8')))
  harnessProcess.stderr.on('data', chunk => consumeOutput(chunk.toString('utf8')))
  harnessProcess.once('error', error => {
    showStatus('Unable to start', `The bundled runtime could not start.\n\n${error.message}`)
  })
  harnessProcess.once('exit', code => {
    if (shuttingDown) return
    const detail = recentOutput.slice(-8).join('\n')
    showStatus('Harness stopped', `The local Harness process exited with status ${code ?? 'unknown'}.\n\n${detail}`)
  })
}

function stopHarness() {
  if (shuttingDown) return
  shuttingDown = true
  const pid = harnessProcess?.pid
  if (!pid || harnessProcess.killed) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.unref()
  } else {
    harnessProcess.kill('SIGTERM')
  }
}

const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.whenReady().then(() => {
    app.setAppUserModelId('io.github.wendymyyht-ctrl.deepseek-harness-optimized')
    createWindow()
    startHarness()
  })
  app.on('before-quit', stopHarness)
  app.on('window-all-closed', () => app.quit())
}
