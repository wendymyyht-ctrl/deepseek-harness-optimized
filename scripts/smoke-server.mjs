import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const root = resolve(process.argv[2] || '.')
const home = await mkdtemp(join(tmpdir(), 'dsh-release-smoke-'))
const child = spawn(process.execPath, [join(root, 'scripts/app-server.mjs')], {
  cwd: root, env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore','pipe','pipe'],
})
let output = ''
child.stdout.on('data', c => { output += c })
child.stderr.on('data', c => { output += c })
try {
  const deadline = Date.now() + 600000
  let url
  while (!(url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/)?.[1])) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(output.slice(-12000))
    await new Promise(r => setTimeout(r, 200))
  }
  const bootstrap = await fetch(url, { redirect: 'manual' })
  assert.equal(bootstrap.status, 303)
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0]
  const origin = new URL(url).origin
  assert.equal((await fetch(origin)).status, 401)
  assert.equal((await fetch(origin, { headers: { cookie } })).status, 200)
  const vision = await fetch(origin + '/_dsh/vision-toolkit/settings', { headers: { cookie } })
  assert.equal(vision.status, 200, output.replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]'))
  console.log('PASS: clean-home boot, required authentication, frontend and vision settings')
} finally {
  child.kill('SIGTERM')
  await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r))
  await rm(home, { recursive: true, force: true })
}
