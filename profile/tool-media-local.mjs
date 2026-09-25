import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-media-local'
export const inject = ['tools']

const YT_DLP = process.env.DSH_YT_DLP_BIN || 'yt-dlp'
const OUTPUT_LIMIT = 1_000_000
const TRANSCRIPT_LIMIT = 160_000

function runYtDlp(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP, args, {
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
    const collect = (target, chunk) => {
      const next = target + chunk.toString('utf8')
      return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next
    }
    child.stdout.on('data', chunk => { stdout = collect(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = collect(stderr, chunk) })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`yt-dlp exited with code ${code}: ${stderr.trim() || stdout.trim()}`))
    })
  })
}

function compactLanguages(value) {
  return Object.keys(value || {}).filter(Boolean).slice(0, 120)
}

function formatTimestamp(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return [hours, minutes, rest].map(value => String(value).padStart(2, '0')).join(':')
}

function json3ToTranscript(value) {
  const lines = []
  let previous = ''
  for (const event of value?.events || []) {
    const text = (event?.segs || [])
      .map(segment => segment?.utf8 || '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text || text === previous) continue
    lines.push(`[${formatTimestamp(event.tStartMs)}] ${text}`)
    previous = text
  }
  return lines.join('\n')
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'media_probe',
    description: 'Inspect a public video or audio URL with the local yt-dlp executable. Returns title, creator, duration, description, and available subtitle languages. Use before requesting a transcript when the language is unknown.',
    parameters: {
      url: { type: 'string', required: true, description: 'Public video or audio page URL.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const { stdout } = await runYtDlp([
        '--dump-single-json',
        '--skip-download',
        '--no-warnings',
        '--no-playlist',
        '--',
        args.url,
      ], exec.signal)
      const data = JSON.parse(stdout)
      return JSON.stringify({
        title: data.title || null,
        creator: data.uploader || data.channel || data.creator || null,
        durationSeconds: Number.isFinite(data.duration) ? data.duration : null,
        webpageUrl: data.webpage_url || args.url,
        description: typeof data.description === 'string' ? data.description.slice(0, 12_000) : null,
        subtitles: compactLanguages(data.subtitles),
        automaticCaptions: compactLanguages(data.automatic_captions),
      }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'media_transcript',
    description: 'Extract timestamped subtitles from a public video or audio URL with the local yt-dlp executable. Prefer an original caption language such as en; translate the returned transcript locally if needed.',
    parameters: {
      url: { type: 'string', required: true, description: 'Public video or audio page URL.' },
      language: { type: 'string', description: 'Exact subtitle language code, for example en, zh-Hans, or ja. Defaults to en.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const language = (args.language || 'en').trim()
      if (!/^[A-Za-z0-9_-]{1,24}$/.test(language)) {
        throw new Error(`invalid subtitle language code: ${language}`)
      }

      const directory = await mkdtemp(join(tmpdir(), 'dsh-media-'))
      try {
        await runYtDlp([
          '--skip-download',
          '--write-subs',
          '--write-auto-subs',
          '--sub-langs', language,
          '--sub-format', 'json3',
          '--no-playlist',
          '--no-warnings',
          '-o', join(directory, '%(id)s.%(ext)s'),
          '--',
          args.url,
        ], exec.signal)
        const filenames = (await readdir(directory)).filter(file => file.endsWith('.json3')).sort()
        if (!filenames.length) {
          throw new Error(`no ${language} subtitles were produced for this URL`)
        }
        const raw = await readFile(join(directory, filenames[0]), 'utf8')
        const transcript = json3ToTranscript(JSON.parse(raw))
        if (!transcript) throw new Error('the subtitle file contained no readable transcript')
        const clipped = transcript.length > TRANSCRIPT_LIMIT
          ? `${transcript.slice(0, TRANSCRIPT_LIMIT)}\n\n[Transcript truncated at ${TRANSCRIPT_LIMIT} characters]`
          : transcript
        return `Language: ${language}\nSource: ${args.url}\n\n${clipped}`
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  }))
}
