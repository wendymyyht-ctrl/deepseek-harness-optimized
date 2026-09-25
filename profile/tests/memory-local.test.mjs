import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('explicit memory persists, searches and forgets in an isolated user home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-memory-test-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { apply } = await import('../tool-memory-local.mjs')
    const tools = new Map()
    apply({ tools: { register: tool => tools.set(tool.name, tool) } })
    await tools.get('memory_save').execute({ key: 'test.preference', content: 'likes blue widgets', tags: 'test' })
    const results = JSON.parse(await tools.get('memory_search').execute({ query: 'blue widgets' }))
    assert.equal(results.length, 1)
    assert.equal(results[0].key, 'test.preference')
    await tools.get('memory_forget').execute({ key: 'test.preference' })
    assert.deepEqual(JSON.parse(await tools.get('memory_search').execute({ query: 'blue widgets' })), [])
  } finally {
    if(previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, {recursive: true, force: true})
  }
})
