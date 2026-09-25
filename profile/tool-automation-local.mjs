import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  compactTask,
  createTask,
  DEFAULT_AUTOMATION_HOME,
  deleteTask,
  ensureLaunchAgent,
  executeTask,
  listTasksWithState,
  readTasks,
} from './automation-core-local.mjs'

export const name = 'tool-automation-local'
export const inject = ['tools', 'systemPrompt']

const RUNNER_PATH = fileURLToPath(new URL('./automation-runner-local.mjs', import.meta.url))

function stringOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  }
}

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'tool:automation-local',
    order: 98,
    text: process.platform === 'win32' ? 'Use automation_create for local cron jobs. On Windows they run only while Harness is open; explicitly tell the user this limit. Never store credentials in task arguments.' : 'For a persistent or unattended local automation, use automation_create instead of schedule_create. automation_create installs a macOS LaunchAgent-backed runner that survives Harness restarts and interprets cron in the explicit IANA time zone. Do not inspect the Harness runtime to discover schedulers. First create the smallest deterministic script or executable needed, then call automation_create with its absolute program path and arguments, and call automation_run at most once for a smoke test. Reuse the installed Chrome/Playwright stack; never install a browser, Python package, Node package, or alternate runtime during automation deployment unless the user explicitly asks. Never place credentials in automation arguments or files; use an existing Keychain/account integration. If one approach returns the same failure twice, stop retrying it and report the concrete blocker or ask for the missing credential/choice. Use schedule_create only for session-local reminders.',
  })

  ctx.tools.register(defineTool({
    name: 'automation_create',
    description: process.platform === 'win32' ? 'Create a local cron automation. Runs only while Harness is open on Windows.' : 'Create a durable macOS automation backed by launchd. The executable runs independently of the Harness session on a five-field cron schedule interpreted in the supplied IANA time zone. Create any required script first, then register it here; do not use this for a session-only reminder.',
    parameters: {
      name: { type: 'string', required: true, description: 'Human-readable task name.' },
      cron: { type: 'string', required: true, description: 'Five numeric cron fields: minute hour day-of-month month day-of-week. Example: "0 22 * * *".' },
      timeZone: { type: 'string', required: true, description: 'IANA time zone such as Asia/Shanghai or Europe/London.' },
      program: { type: 'string', required: true, description: 'Absolute path to an existing executable. For complex commands, create a script and provide its interpreter or executable path.' },
      arguments: { type: 'array', items: { type: 'string' }, description: 'Argument vector passed directly to the executable without shell interpolation.' },
      cwd: { type: 'string', description: 'Absolute working directory. Defaults to the executable directory.' },
      timeoutSeconds: { type: 'number', description: 'Execution timeout from 5 to 86400 seconds. Defaults to 900.' },
      enabled: { type: 'boolean', description: 'Whether the automation is active. Defaults to true.' },
    },
    output: stringOutput(),
    async execute(args) {
      const task = await createTask(args, DEFAULT_AUTOMATION_HOME)
      const runner = process.platform === 'win32' ? { mode: 'while-app-open' } : await ensureLaunchAgent({
        nodePath: process.execPath,
        runnerPath: RUNNER_PATH,
        home: DEFAULT_AUTOMATION_HOME,
      })
      return JSON.stringify({ created: true, task: compactTask(task), runner }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'automation_list',
    description: 'List durable local automations and their most recent execution state. Use this before creating a possible duplicate.',
    parameters: {},
    output: stringOutput(),
    isConcurrencySafe: () => true,
    async execute() {
      const tasks = await listTasksWithState(DEFAULT_AUTOMATION_HOME)
      return JSON.stringify(tasks.map(compactTask), null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'automation_delete',
    description: 'Disable and remove one durable local automation by its exact automation_list id. Historical logs remain on disk.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact automation id, for example auto_0123456789abcdef.' },
    },
    output: stringOutput(),
    async execute(args) {
      const deleted = await deleteTask(args.id, DEFAULT_AUTOMATION_HOME)
      return JSON.stringify({ id: args.id, deleted })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'automation_run',
    description: 'Run one existing durable automation immediately as a single smoke test and return bounded stdout/stderr plus exit status. Do not call repeatedly after the same failure.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact automation id returned by automation_create or automation_list.' },
    },
    output: stringOutput(),
    async execute(args) {
      const task = (await readTasks(DEFAULT_AUTOMATION_HOME)).find(candidate => candidate.id === args.id)
      if (!task) throw new Error(`automation not found: ${args.id}`)
      const result = await executeTask(task, { home: DEFAULT_AUTOMATION_HOME, trigger: 'manual', capture: true })
      return JSON.stringify({ id: task.id, name: task.name, ...result }, null, 2)
    },
  }))
}
