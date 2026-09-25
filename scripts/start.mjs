import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installProfile } from './setup.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installed = await installProfile()
const integrationsDirectory = join(installed.home, 'integrations')
const integrationsConfigFile = join(integrationsDirectory, 'config.json')
const googleConfigDirectory = join(integrationsDirectory, 'google-workspace')
const emailDirectory = join(integrationsDirectory, 'email')
const emailCredentialsDirectory = join(emailDirectory, 'credentials')
const notionAuthDirectory = join(integrationsDirectory, 'notion-mcp')
await Promise.all([
  mkdir(googleConfigDirectory, { recursive: true, mode: 0o700 }),
  mkdir(emailCredentialsDirectory, { recursive: true, mode: 0o700 }),
  mkdir(notionAuthDirectory, { recursive: true, mode: 0o700 }),
])
let enabledIntegrations = { github: false, notion: false }
try {
  const parsed = JSON.parse(await readFile(integrationsConfigFile, 'utf8'))
  enabledIntegrations = { github: parsed?.github === true, notion: parsed?.notion === true }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
const executable = join(
  repositoryRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
)
const child = spawn(executable, ['--profile', installed.name, ...process.argv.slice(2)], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    DSH_HOME: installed.home,
    DSH_RUNTIME_HOME: installed.home,
    DSH_NODE_BIN: process.execPath,
    DSH_PLAYWRIGHT_ENTRY: join(dirname(createRequire(join(repositoryRoot, 'profile', 'package.json')).resolve('@playwright/mcp/package.json')), 'cli.js'),
    DSH_BROWSER_HOME: join(installed.home, 'browser-profile'),
    DSH_GWS_BIN: installed.vendor.gws,
    DSH_GITHUB_MCP_BIN: installed.vendor.githubMcp,
    DSH_MCP_REMOTE_ENTRY: join(repositoryRoot, 'profile', 'node_modules', 'mcp-remote', 'dist', 'proxy.js'),
    DSH_INTEGRATIONS_CONFIG_FILE: integrationsConfigFile,
    DSH_GOOGLE_CONFIG_DIR: googleConfigDirectory,
    DSH_EMAIL_ACCOUNTS_FILE: join(emailDirectory, 'accounts.json'),
    DSH_EMAIL_CREDENTIALS_DIR: emailCredentialsDirectory,
    DSH_EMAIL_KEYCHAIN_SERVICE: 'DeepSeek Harness Optimized Email Authorization Code',
    DSH_NOTION_AUTH_DIR: notionAuthDirectory,
    DSH_GITHUB_ENABLED: enabledIntegrations.github ? '1' : '0',
    DSH_NOTION_ENABLED: enabledIntegrations.notion ? '1' : '0',
  },
  shell: process.platform === 'win32',
  stdio: 'inherit',
})

const scheduleRunner = process.platform === 'win32' ? spawn(process.execPath,
  [join(installed.destination, 'automation-runner-local.mjs')], {
    env: { ...process.env, DSH_HOME: installed.home }, stdio: 'inherit',
  }) : null
scheduleRunner?.once('error', error => process.stderr.write(`Automation runner: ${error.message}\n`))
child.once('exit', () => scheduleRunner?.kill())

child.once('error', error => {
  process.stderr.write(`Unable to start DeepSeek Harness: ${error.message}\n`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
