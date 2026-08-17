import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceProfile = join(appRoot, 'profile')
const profileName = process.env.DSH_PROFILE?.trim() || 'optimized-app'
const runtimeHome = resolve(
  process.env.DSH_HOME?.trim()
    || join(homedir(), 'Library', 'Application Support', 'DeepSeek Harness Optimized'),
)
const targetProfile = join(runtimeHome, 'profiles', profileName)
const markerPath = join(targetProfile, '.managed-by-deepseek-harness-optimized.json')
const managedFiles = [
  'package.json',
  'cordis.yml',
  'cordis.patch.yml',
  'auto-compact-continue.mjs',
  'tool-html-local.mjs',
]

async function installManagedProfile() {
  if (existsSync(targetProfile) && !existsSync(markerPath)) {
    throw new Error(
      `${targetProfile} already exists but is not managed by this app; refusing to overwrite it`,
    )
  }
  await mkdir(targetProfile, { recursive: true })
  for (const filename of managedFiles) {
    await copyFile(join(sourceProfile, filename), join(targetProfile, filename))
  }
  const manifest = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
  await writeFile(markerPath, `${JSON.stringify({ version: manifest.version }, null, 2)}\n`, 'utf8')
}

await installManagedProfile()
const dshBin = join(appRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const child = spawn(process.execPath, [
  dshBin,
  '--profile',
  profileName,
  '--port',
  '0',
  ...process.argv.slice(2),
], {
  cwd: appRoot,
  env: { ...process.env, DSH_HOME: runtimeHome },
  stdio: 'inherit',
})

let stopping = false
function stop(signal) {
  if (stopping) return
  stopping = true
  if (!child.killed) child.kill(signal)
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
