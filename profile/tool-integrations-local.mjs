import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-integrations-local'
export const inject = ['tools']

const CONFIG_FILE = process.env.DSH_INTEGRATIONS_CONFIG_FILE?.trim()
const SUPPORTED = ['github', 'notion']
const DEFAULTS = { github: false, notion: false }

async function readConfig() {
  if (!CONFIG_FILE) return { ...DEFAULTS }
  try {
    const parsed = JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
    return Object.fromEntries(SUPPORTED.map(provider => [provider, parsed?.[provider] === true]))
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...DEFAULTS }
    throw new Error(`unable to read integration configuration: ${error}`)
  }
}

async function writeConfig(config) {
  if (!CONFIG_FILE) throw new Error('the integration configuration path is unavailable')
  const directory = dirname(CONFIG_FILE)
  const temporary = `${CONFIG_FILE}.tmp-${process.pid}`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, CONFIG_FILE)
  await chmod(CONFIG_FILE, 0o600).catch(() => {})
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'integration_status',
    description: 'Show whether the optional GitHub and Notion OAuth connectors are enabled for this local Harness installation. This never returns credentials, tokens, or account data.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const enabled = await readConfig()
      return JSON.stringify({
        github: { enabled: enabled.github, authentication: 'Official GitHub MCP browser OAuth on first use' },
        notion: { enabled: enabled.notion, authentication: 'Official Notion MCP browser OAuth after restart' },
        google: { enabled: true, authentication: 'Use google_workspace_auth_status or google_workspace_auth_login' },
        email: { enabled: true, authentication: 'Add an account through the desktop app menu; authorization codes stay in the OS credential store' },
      }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'integration_set_enabled',
    description: 'Enable or disable an optional GitHub or Notion connector in the private local runtime. Enabling does not grant account access by itself; the user must complete the provider OAuth flow after restarting the app. Never claim an account is connected until its OAuth flow succeeds.',
    parameters: {
      provider: { type: 'string', required: true, enum: SUPPORTED },
      enabled: { type: 'boolean', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      if (!SUPPORTED.includes(args.provider)) throw new Error(`unsupported integration: ${args.provider}`)
      const config = await readConfig()
      config[args.provider] = args.enabled === true
      await writeConfig(config)
      return JSON.stringify({
        provider: args.provider,
        enabled: config[args.provider],
        restartRequired: true,
        next: config[args.provider]
          ? 'Restart DeepSeek Harness Optimized, then complete the provider login in the browser when prompted.'
          : 'Restart DeepSeek Harness Optimized to unload this connector.',
      }, null, 2)
    },
  }))
}
