const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync } = require('node:fs')
const { mkdir, readFile, rename, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')

const APP_NAME = 'DeepSeek Harness Optimized'
const URL_PATTERN = /http:\/\/(?:127\.0\.0\.1|localhost):[0-9]+/u
const MAX_RECENT_LINES = 24

let mainWindow
let emailWindow
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
    autoHideMenuBar: false,
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

function emailSetupDocument() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Email Account Settings</title><style>
:root{font-family:Segoe UI,system-ui,sans-serif;color-scheme:light dark}body{margin:0;padding:28px;background:#0b1020;color:#f7f9ff}h1{font-size:22px;margin:0 0 10px}p{color:#b8c2dc;line-height:1.45}label{display:block;margin:16px 0 6px;font-weight:600}input,select{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid #59647d;border-radius:8px;background:#111a31;color:#fff}footer{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}button{padding:9px 16px;border:0;border-radius:8px;cursor:pointer}button.primary{background:#4c6fff;color:#fff}.message{min-height:20px;margin-top:12px;color:#ffb4b4}
</style></head><body><h1>Add or update an email account</h1><p>Enable IMAP/SMTP in QQ Mail or NetEase Mail first. The authorization code is encrypted with Windows DPAPI for this Windows user and never written to the app profile or repository.</p>
<form id="form"><label for="provider">Provider</label><select id="provider"><option value="qq">QQ Mail</option><option value="netease">NetEase Mail (163/126/yeah)</option></select><label for="email">Email address</label><input id="email" type="email" autocomplete="username" required placeholder="name@qq.com"><label for="code">Client authorization code</label><input id="code" type="password" autocomplete="new-password" required placeholder="Not the web login password"><div class="message" id="message"></div><footer><button type="button" id="cancel">Cancel</button><button class="primary" type="submit">Save securely</button></footer></form>
<script>
const form=document.getElementById('form'),message=document.getElementById('message');document.getElementById('cancel').onclick=()=>window.emailSetup.close();form.onsubmit=async event=>{event.preventDefault();message.textContent='Saving…';const result=await window.emailSetup.save({provider:document.getElementById('provider').value,email:document.getElementById('email').value,authorizationCode:document.getElementById('code').value});message.textContent=result.ok?'Saved. Restart the app before using this account.':result.error;if(result.ok)document.getElementById('code').value=''};
</script></body></html>`
}

function validateEmailAccount({ email, provider, authorizationCode }) {
  const normalizedEmail = String(email || '').trim().toLowerCase()
  const code = String(authorizationCode || '').trim()
  const domain = normalizedEmail.split('@').pop()
  const allowed = provider === 'qq'
    ? ['qq.com', 'foxmail.com', 'vip.qq.com']
    : provider === 'netease' ? ['163.com', '126.com', 'yeah.net'] : []
  if (!normalizedEmail.includes('@') || !allowed.includes(domain)) throw new Error('The email domain does not match the selected provider.')
  if (code.length < 6 || code.length > 128 || /\s/u.test(code)) throw new Error('Enter the provider-generated client authorization code, not the web password.')
  return { email: normalizedEmail, provider, authorizationCode: code }
}

function runPowerShell(script, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...environment },
    })
    let output = ''
    child.stdout.on('data', chunk => { if (output.length < 20_000) output += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { if (output.length < 20_000) output += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(output.trim() || `PowerShell exited with status ${code}`)))
  })
}

async function saveEmailAccount(candidate) {
  const account = validateEmailAccount(candidate)
  const emailDirectory = join(app.getPath('userData'), 'integrations', 'email')
  const credentialsDirectory = join(emailDirectory, 'credentials')
  const accountsFile = join(emailDirectory, 'accounts.json')
  const credentialFile = join(credentialsDirectory, `${createHash('sha256').update(account.email).digest('hex')}.txt`)
  await mkdir(credentialsDirectory, { recursive: true })
  const script = [
    '$secure = ConvertTo-SecureString -String $env:DSH_EMAIL_AUTH_CODE -AsPlainText -Force',
    '$encrypted = ConvertFrom-SecureString -SecureString $secure',
    '[IO.File]::WriteAllText($env:DSH_EMAIL_CREDENTIAL_FILE, $encrypted)',
  ].join('; ')
  await runPowerShell(script, {
    DSH_EMAIL_AUTH_CODE: account.authorizationCode,
    DSH_EMAIL_CREDENTIAL_FILE: credentialFile,
  })

  let document = { accounts: [] }
  try { document = JSON.parse(await readFile(accountsFile, 'utf8')) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!Array.isArray(document.accounts)) document.accounts = []
  document.accounts = document.accounts.filter(item => String(item?.email || '').toLowerCase() !== account.email)
  document.accounts.push({ email: account.email, provider: account.provider })
  document.accounts.sort((left, right) => left.email.localeCompare(right.email))
  const temporary = `${accountsFile}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await rename(temporary, accountsFile)
}

function showEmailAccountSettings() {
  if (emailWindow && !emailWindow.isDestroyed()) {
    emailWindow.focus()
    return
  }
  emailWindow = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    title: 'Email Account Settings',
    width: 560,
    height: 600,
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: join(__dirname, 'email-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  emailWindow.removeMenu()
  emailWindow.on('closed', () => { emailWindow = undefined })
  void emailWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(emailSetupDocument())}`)
}

function configureApplicationMenu() {
  const template = [
    {
      label: 'DeepSeek Harness Optimized',
      submenu: [
        { label: 'Email Account Settings…', accelerator: 'CmdOrCtrl+,', click: showEmailAccountSettings },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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

ipcMain.handle('email-account-save', async (event, candidate) => {
  if (!emailWindow || event.sender !== emailWindow.webContents) return { ok: false, error: 'Untrusted settings window.' }
  try {
    await saveEmailAccount(candidate)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
})
ipcMain.on('email-account-close', event => {
  if (emailWindow && event.sender === emailWindow.webContents) emailWindow.close()
})

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
    configureApplicationMenu()
    startHarness()
  })
  app.on('before-quit', stopHarness)
  app.on('window-all-closed', () => app.quit())
}
