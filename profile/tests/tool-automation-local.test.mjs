import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  automationPaths,
  compactTask,
  createTask,
  cronMatches,
  deleteTask,
  executeTask,
  launchAgentPlist,
  listTasksWithState,
  parseCron,
  scheduleBucket,
} from '../automation-core-local.mjs'
import { apply } from '../tool-automation-local.mjs'

test('registers durable automation tools and convergence guidance', () => {
  const tools = new Map()
  const sections = []
  apply({
    tools: { register: tool => tools.set(tool.name, tool) },
    systemPrompt: { section: section => sections.push(section) },
  })
  assert.deepEqual([...tools.keys()], ['automation_create', 'automation_list', 'automation_delete', 'automation_run'])
  assert.match(sections[0].text, /Do not inspect the Harness runtime/u)
  assert.match(sections[0].text, /at most once/u)
})

test('matches cron in an explicit time zone and validates fields', () => {
  const instant = new Date('2026-08-17T14:00:00.000Z')
  assert.equal(cronMatches('0 22 * * *', instant, 'Asia/Shanghai'), true)
  assert.equal(cronMatches('0 22 * * *', instant, 'Europe/London'), false)
  assert.equal(scheduleBucket(instant, 'Asia/Shanghai'), '2026-08-17T22:00@Asia/Shanghai')
  assert.throws(() => parseCron('0 99 * * *'), /hour cron value/u)
  assert.throws(() => parseCron('0 22 * *'), /exactly five/u)
})

test('persists, executes, reports, and deletes a task', async context => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-automation-test-'))
  context.after(() => rm(home, { recursive: true, force: true }))
  const task = await createTask({
    name: 'smoke',
    cron: '*/5 * * * *',
    timeZone: 'Europe/London',
    program: process.execPath,
    arguments: ['-e', "process.stdout.write('automation-ok')"],
    cwd: home,
    timeoutSeconds: 30,
  }, home)
  assert.match(task.id, /^auto_[a-z0-9]{16}$/u)
  assert.equal((await listTasksWithState(home)).length, 1)

  const result = await executeTask(task, { home, trigger: 'test', capture: true })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.stdout, 'automation-ok')
  const listed = (await listTasksWithState(home))[0]
  assert.equal(listed.state.status, 'succeeded')
  assert.equal(listed.state.runs, 1)
  assert.equal(compactTask(listed).command[0], process.execPath)
  assert.match(await readFile(join(automationPaths(home).logs, `${task.id}.stdout.log`), 'utf8'), /automation-ok/u)

  assert.equal(await deleteTask(task.id, home), true)
  assert.equal(await deleteTask(task.id, home), false)
  assert.deepEqual(await listTasksWithState(home), [])
})

test('renders a launch agent with exact argument boundaries', () => {
  const plist = launchAgentPlist({
    nodePath: '/Applications/DeepSeek Harness.app/Contents/Resources/node',
    runnerPath: '/tmp/runner & check.mjs',
    home: '/tmp/automation home',
  })
  assert.match(plist, /DeepSeek Harness\.app/u)
  assert.match(plist, /runner &amp; check\.mjs/u)
  assert.match(plist, /DSH_AUTOMATION_HOME/u)
  assert.doesNotMatch(plist, /sh -c/u)
})
