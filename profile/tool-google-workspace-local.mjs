import { spawn } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-google-workspace-local'
export const inject = ['tools']

const GWS = process.env.DSH_GWS_BIN?.trim()
const CONFIG_DIR = process.env.DSH_GOOGLE_CONFIG_DIR?.trim()
const SERVICES = [
  'drive', 'sheets', 'gmail', 'calendar', 'admin-reports', 'reports', 'docs',
  'slides', 'tasks', 'people', 'chat', 'classroom', 'forms', 'keep', 'meet',
  'events', 'modelarmor', 'workflow', 'wf', 'script',
]

function run(args, signal) {
  if (!GWS) throw new Error('Google Workspace CLI is not bundled or DSH_GWS_BIN is not configured')
  return new Promise((resolve, reject) => {
    const child = spawn(GWS, args, {
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: process.env.HOME,
        LANG: 'en_US.UTF-8',
        GOOGLE_WORKSPACE_CLI_CONFIG_DIR: CONFIG_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { if (stdout.length < 1_000_000) stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { if (stderr.length < 200_000) stderr += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', code => {
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
      if (code === 0) resolve(combined)
      else reject(new Error(`Google Workspace command failed with code ${code}: ${combined}`))
    })
  })
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'google_workspace_auth_status',
    description: 'Check whether this local Harness installation is connected to Google Workspace. This is read-only and never returns OAuth tokens.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      return run(['auth', 'status'], exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'google_workspace_auth_login',
    description: 'Start the official Google Workspace CLI OAuth login in the user browser. Call only after the user explicitly asks to connect Google. OAuth credentials are stored by the CLI in the private Harness runtime directory and are never returned to the model.',
    parameters: {
      services: {
        type: 'array',
        items: { type: 'string', enum: SERVICES },
        description: 'Google services to authorize. Defaults to Drive, Gmail, Calendar, Docs, Sheets, Slides, Tasks, and People.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const services = Array.isArray(args.services) && args.services.length
        ? [...new Set(args.services)]
        : ['drive', 'gmail', 'calendar', 'docs', 'sheets', 'slides', 'tasks', 'people']
      if (services.some(service => !SERVICES.includes(service))) throw new Error('unsupported Google Workspace service')
      return run(['auth', 'login', '-s', services.join(',')], exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'google_workspace_schema',
    description: 'Inspect the current Google Workspace API schema for an exact method before calling it, for example drive.files.list, gmail.users.messages.list, or sheets.spreadsheets.values.get.',
    parameters: {
      method: { type: 'string', required: true, description: 'Dotted Google method identifier.' },
      resolveRefs: { type: 'boolean', description: 'Inline referenced schemas when true.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const method = args.method.trim()
      if (!/^[A-Za-z0-9_.:-]{3,200}$/.test(method)) throw new Error('invalid Google Workspace method identifier')
      const command = ['schema', method]
      if (args.resolveRefs) command.push('--resolve-refs')
      return run(command, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'google_workspace_call',
    description: 'Run a Google Workspace CLI operation after inspecting its schema. This covers Drive, Gmail, Docs, Sheets, Calendar, Slides, Tasks, Contacts, Chat, and other Workspace APIs. Before any remote change such as sending mail, uploading, editing, sharing, moving, or deleting, explain the exact action and obtain explicit user confirmation in the immediately preceding user message.',
    parameters: {
      service: { type: 'string', required: true, enum: SERVICES, description: 'Google Workspace service.' },
      arguments: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Exact CLI arguments after the service, for example ["files", "list", "--params", "{\\"pageSize\\":5}"]. No shell is used.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (!SERVICES.includes(args.service)) throw new Error(`unsupported Google Workspace service: ${args.service}`)
      if (!Array.isArray(args.arguments) || args.arguments.length < 1 || args.arguments.length > 100) {
        throw new Error('arguments must contain 1 to 100 entries')
      }
      if (args.arguments.some(value => typeof value !== 'string' || value.includes('\0') || value.length > 100_000)) {
        throw new Error('invalid Google Workspace argument')
      }
      return run([args.service, ...args.arguments], exec.signal)
    },
  }))
}
