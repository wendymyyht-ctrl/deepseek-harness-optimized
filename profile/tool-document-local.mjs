import { spawn } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-document-local'
export const inject = ['tools']

const MARKITDOWN = process.env.DSH_MARKITDOWN_BIN || 'markitdown'
const HARD_OUTPUT_LIMIT = 2_000_000

function run(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        HOME: process.env.HOME,
        LANG: 'en_US.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      if (stdout.length < HARD_OUTPUT_LIMIT) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', chunk => {
      if (stderr.length < 100_000) stderr += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve(stdout.slice(0, HARD_OUTPUT_LIMIT))
      else reject(new Error(`document conversion failed with code ${code}: ${stderr.trim() || stdout.trim()}`))
    })
  })
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'document_extract',
    description: 'Extract text and structure locally from PDF, Word (DOCX), Excel (XLS/XLSX), Outlook MSG, HTML, CSV, JSON, XML, EPUB, ZIP, or another Microsoft MarkItDown-supported source. Returns Markdown suitable for local analysis; this does not call a cloud model.',
    parameters: {
      source: { type: 'string', required: true, description: 'Absolute local file path or supported public URL.' },
      maxChars: { type: 'number', description: 'Maximum returned characters, from 1000 to 500000. Defaults to 200000.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const source = args.source.trim()
      if (!source) throw new Error('source is required')
      const maxChars = Number(args.maxChars ?? 200_000)
      if (!Number.isInteger(maxChars) || maxChars < 1_000 || maxChars > 500_000) {
        throw new Error('maxChars must be an integer from 1000 to 500000')
      }
      const markdown = await run(MARKITDOWN, [source], exec.signal)
      if (markdown.length <= maxChars) return markdown
      return `${markdown.slice(0, maxChars)}\n\n[Document output truncated at ${maxChars} characters]`
    },
  }))
}
