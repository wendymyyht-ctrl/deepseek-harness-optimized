import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const profileRoot = new URL('../', import.meta.url)

test('Vision Toolkit is pinned and enabled without a private provider', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', profileRoot), 'utf8'))
  const patch = await readFile(new URL('cordis.patch.yml', profileRoot), 'utf8')

  assert.equal(manifest.dependencies['@anionex/dsh-vision-toolkit'], '0.1.45')
  assert.ok(manifest.dsh.profile.bundles.includes('@anionex/dsh-vision-toolkit'))
  assert.doesNotMatch(patch, /(?:baseUrl|credential|apiKey):/u)
})
