import { createRequire } from 'node:module'
import { copyFile, cp, mkdir, readFile, writeFile, symlink, lstat, readlink, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceProfile = join(appRoot, 'profile')
const profileName = process.env.DSH_PROFILE?.trim() || 'optimized-app'
function defaultRuntimeHome() {
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'DeepSeek Harness Optimized')
  }
  if (platform() === 'win32') {
    return join(process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming'), 'DeepSeek Harness Optimized')
  }
  return join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'), 'deepseek-harness-optimized')
}

const runtimeHome = resolve(process.env.DSH_HOME?.trim() || defaultRuntimeHome())
const targetProfile = join(runtimeHome, 'profiles', profileName)
const markerPath = join(targetProfile, '.managed-by-deepseek-harness-optimized.json')
const managedFiles = [
  'package.json',
  'cordis.yml',
  'cordis.patch.yml',
  'auto-compact-continue.mjs',
  'tool-html-local.mjs',
  'tool-integrations-local.mjs',
  'tool-google-workspace-local.mjs',
  'tool-email-local.mjs',
  'tool-memory-local.mjs', 'tool-document-local.mjs', 'tool-media-local.mjs',
  'tool-automation-local.mjs', 'automation-core-local.mjs', 'automation-runner-local.mjs', 'web-search-public.mjs',
]

const integrationsDirectory = join(runtimeHome, 'integrations')
const integrationsConfigFile = join(integrationsDirectory, 'config.json')
const googleConfigDirectory = join(integrationsDirectory, 'google-workspace')
const emailDirectory = join(integrationsDirectory, 'email')
const emailCredentialsDirectory = join(emailDirectory, 'credentials')
const notionAuthDirectory = join(integrationsDirectory, 'notion-mcp')

async function integrationFlags() {
  try {
    const parsed = JSON.parse(await readFile(integrationsConfigFile, 'utf8'))
    return { github: parsed?.github === true, notion: parsed?.notion === true }
  } catch (error) {
    if (error?.code === 'ENOENT') return { github: false, notion: false }
    throw new Error(`Unable to read ${integrationsConfigFile}: ${error}`)
  }
}

function mcpRemoteEntry() {
  const candidates = [
    join(appRoot, 'node_modules', 'mcp-remote', 'dist', 'proxy.js'),
    join(appRoot, 'profile', 'node_modules', 'mcp-remote', 'dist', 'proxy.js'),
  ]
  const found = candidates.find(existsSync)
  if (!found) throw new Error('The bundled mcp-remote entrypoint is missing')
  return found
}

async function installManagedProfile() {
  if (existsSync(targetProfile) && !existsSync(markerPath)) {
    throw new Error(
      `${targetProfile} already exists but is not managed by this app; refusing to overwrite it`,
    )
  }
  const manifest = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
  let previous
  try { previous = JSON.parse(await readFile(markerPath, 'utf8')) } catch (error) { if(error.code !== 'ENOENT') throw error }
  const modules = join(targetProfile, 'node_modules')
  const bundledModules = existsSync(join(sourceProfile, 'node_modules')) ? join(sourceProfile, 'node_modules') : join(appRoot, 'node_modules')
  await mkdir(targetProfile, { recursive: true })
  try {
    const info = await lstat(modules)
    if (!info.isSymbolicLink()) throw new Error('Managed node_modules must be a link')
    if (resolve(await readlink(modules)) !== bundledModules) { await rm(modules); await symlink(bundledModules, modules, platform() === 'win32' ? 'junction' : 'dir') }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await symlink(bundledModules, modules, platform() === 'win32' ? 'junction' : 'dir')
  }
  if (previous?.version === manifest.version) return
  if (previous) await cp(targetProfile, join(runtimeHome, 'profile-backups', `${profileName}-${previous.version}-${Date.now()}`), { recursive: true })
  await mkdir(targetProfile, { recursive: true })
  for (const filename of managedFiles) {
    await copyFile(join(sourceProfile, filename), join(targetProfile, filename))
  }
  await writeFile(markerPath, `${JSON.stringify({ version: manifest.version }, null, 2)}\n`, 'utf8')
}

await installManagedProfile()
await Promise.all([
  mkdir(googleConfigDirectory, { recursive: true, mode: 0o700 }),
  mkdir(emailCredentialsDirectory, { recursive: true, mode: 0o700 }),
  mkdir(notionAuthDirectory, { recursive: true, mode: 0o700 }),
])
const enabledIntegrations = await integrationFlags()
const executableSuffix = platform() === 'win32' ? '.exe' : ''
const dshBin = join(appRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const child = spawn(process.execPath, [
  dshBin,
  '--profile',
  profileName,
  '--no-open',
  '--port',
  '0',
  ...process.argv.slice(2),
], {
  cwd: appRoot,
  env: {
    ...process.env,
    DSH_HOME: runtimeHome,
    DSH_RUNTIME_HOME: runtimeHome,
    DSH_NODE_BIN: process.execPath,
    DSH_PLAYWRIGHT_ENTRY: join(dirname(createRequire(join(appRoot, 'profile', 'package.json')).resolve('@playwright/mcp/package.json')), 'cli.js'),
    DSH_BROWSER_HOME: join(runtimeHome, 'browser-profile'),
    DSH_GWS_BIN: join(appRoot, 'vendor', 'bin', `gws${executableSuffix}`),
    DSH_GITHUB_MCP_BIN: join(appRoot, 'vendor', 'bin', `github-mcp-server${executableSuffix}`),
    DSH_MCP_REMOTE_ENTRY: mcpRemoteEntry(),
    DSH_INTEGRATIONS_CONFIG_FILE: integrationsConfigFile,
    DSH_GOOGLE_CONFIG_DIR: googleConfigDirectory,
    DSH_EMAIL_ACCOUNTS_FILE: join(emailDirectory, 'accounts.json'),
    DSH_EMAIL_CREDENTIALS_DIR: emailCredentialsDirectory,
    DSH_EMAIL_KEYCHAIN_SERVICE: 'DeepSeek Harness Optimized Email Authorization Code',
    DSH_NOTION_AUTH_DIR: notionAuthDirectory,
    DSH_GITHUB_ENABLED: enabledIntegrations.github ? '1' : '0',
    DSH_NOTION_ENABLED: enabledIntegrations.notion ? '1' : '0',
  },
  stdio: 'inherit',
})

const scheduleRunner = process.platform === 'win32' ? spawn(process.execPath,
  [join(targetProfile, 'automation-runner-local.mjs')], {
    env: { ...process.env, DSH_HOME: runtimeHome }, stdio: 'inherit',
  }) : null
scheduleRunner?.once('error', error => process.stderr.write(`Automation runner: ${error.message}\n`))
child.once('exit', () => scheduleRunner?.kill())

let stopping = false
function stop(signal) {
  if (stopping) return
  stopping = true
  if (!child.killed) child.kill(signal)
  scheduleRunner?.kill()
}

process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))
child.once('error', error => {
  process.stderr.write(`Unable to start DeepSeek Harness: ${error.message}\n`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal && signal !== 'SIGINT' && signal !== 'SIGTERM') {
    process.stderr.write(`DeepSeek Harness stopped with ${signal}.\n`)
  }
  process.exitCode = code ?? (signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1)
})
