import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

function registry() {
  const definitions = []
  return {
    definitions,
    ctx: { tools: { register(definition) { definitions.push(definition) } } },
  }
}

test('integration switches persist only local booleans', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-integrations-test-'))
  const configFile = join(directory, 'config.json')
  process.env.DSH_INTEGRATIONS_CONFIG_FILE = configFile
  try {
    const plugin = await import(`../tool-integrations-local.mjs?test=${Date.now()}`)
    const registered = registry()
    plugin.apply(registered.ctx)
    assert.deepEqual(registered.definitions.map(item => item.name), [
      'integration_status', 'integration_set_enabled',
    ])
    const toggle = registered.definitions.find(item => item.name === 'integration_set_enabled')
    const result = JSON.parse(await toggle.execute({ provider: 'github', enabled: true }))
    assert.equal(result.restartRequired, true)
    assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), { github: true, notion: false })
  } finally {
    delete process.env.DSH_INTEGRATIONS_CONFIG_FILE
    await rm(directory, { recursive: true, force: true })
  }
})

test('Google and email plugins expose tools without reading an account', async () => {
  process.env.DSH_GWS_BIN = '/nonexistent/gws'
  process.env.DSH_GOOGLE_CONFIG_DIR = '/nonexistent/google'
  process.env.DSH_EMAIL_ACCOUNTS_FILE = '/nonexistent/accounts.json'
  const google = registry()
  const email = registry()
  try {
    const googlePlugin = await import(`../tool-google-workspace-local.mjs?test=${Date.now()}`)
    const emailPlugin = await import(`../tool-email-local.mjs?test=${Date.now()}`)
    googlePlugin.apply(google.ctx)
    emailPlugin.apply(email.ctx)
    assert.deepEqual(google.definitions.map(item => item.name), [
      'google_workspace_auth_status', 'google_workspace_auth_login',
      'google_workspace_schema', 'google_workspace_call',
    ])
    assert.deepEqual(email.definitions.map(item => item.name), [
      'email_accounts', 'email_test', 'email_list', 'email_read', 'email_send',
    ])
  } finally {
    delete process.env.DSH_GWS_BIN
    delete process.env.DSH_GOOGLE_CONFIG_DIR
    delete process.env.DSH_EMAIL_ACCOUNTS_FILE
  }
})
