import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Windows desktop retains token-bearing bootstrap URL', async () => {
  const source = await readFile(new URL('../../windows/electron-main.cjs', import.meta.url), 'utf8')
  const expression = source.match(/const URL_PATTERN = (.+)/)[1]
  const pattern = Function(`return ${expression}`)()
  const url = 'http://127.0.0.1:32123/?token=MY_TEST_token-123'
  assert.equal(`dsh web: ${url}`.match(pattern)[0], url)
})
