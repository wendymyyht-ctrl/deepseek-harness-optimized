import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installProfile } from './setup.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installed = await installProfile()
const executable = join(
  repositoryRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
)
const child = spawn(executable, ['--profile', installed.name, ...process.argv.slice(2)], {
  cwd: repositoryRoot,
  env: { ...process.env, DSH_HOME: installed.home },
  shell: process.platform === 'win32',
  stdio: 'inherit',
})

child.once('error', error => {
  process.stderr.write(`Unable to start DeepSeek Harness: ${error.message}\n`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
