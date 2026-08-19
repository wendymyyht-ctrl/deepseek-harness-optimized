import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { auditReleaseTree } from '../../scripts/audit-release.mjs'

test('release privacy audit rejects machine paths and accepts placeholders', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-release-audit-'))
  const fixture = join(directory, 'config.json')
  try {
    await writeFile(fixture, '{"credential":"MY_LOCAL_CREDENTIAL"}\n', 'utf8')
    await assert.doesNotReject(auditReleaseTree(directory))

    const privatePath = join(homedir(), 'private-cache')
    await writeFile(fixture, `${JSON.stringify({ cache: privatePath })}\n`, 'utf8')
    await assert.rejects(auditReleaseTree(directory), /build-machine home path/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
