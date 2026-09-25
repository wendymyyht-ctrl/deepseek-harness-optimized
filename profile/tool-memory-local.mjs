import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-memory-local'
export const inject = ['tools']

const DATABASE_PATH = join(process.env.DSH_HOME || join(homedir(), '.dsh-optimized'), 'memory', 'long-term.sqlite')

function openDatabase() {
  mkdirSync(dirname(DATABASE_PATH), { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(DATABASE_PATH)
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS memories (
      key TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memories_updated_at_idx ON memories(updated_at DESC);
  `)
  return database
}

function withDatabase(callback) {
  const database = openDatabase()
  try {
    return callback(database)
  } finally {
    database.close()
  }
}

function normalizeLimit(value, fallback = 10) {
  const number = Number(value ?? fallback)
  if (!Number.isInteger(number) || number < 1 || number > 100) {
    throw new Error('limit must be an integer from 1 to 100')
  }
  return number
}

function renderRows(rows) {
  return JSON.stringify(rows, null, 2)
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'memory_save',
    description: 'Save or update a durable, non-secret fact in the local long-term memory database. Use only for stable user preferences, durable project facts, or information the user explicitly asks you to remember. Never store passwords, API keys, access tokens, private keys, or one-time codes.',
    parameters: {
      key: { type: 'string', required: true, description: 'Short stable identifier, for example user.language or project.deepseek.endpoint.' },
      content: { type: 'string', required: true, description: 'The durable fact to remember.' },
      tags: { type: 'string', description: 'Optional comma-separated search tags.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const key = args.key.trim()
      const content = args.content.trim()
      if (!key || key.length > 200) throw new Error('memory key must contain 1 to 200 characters')
      if (!content || content.length > 100_000) throw new Error('memory content must contain 1 to 100000 characters')
      const tags = (args.tags || '').trim().slice(0, 2_000)
      const now = new Date().toISOString()
      return withDatabase(database => {
        database.prepare(`
          INSERT INTO memories(key, content, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            content = excluded.content,
            tags = excluded.tags,
            updated_at = excluded.updated_at
        `).run(key, content, tags, now, now)
        return JSON.stringify({ saved: true, key, updatedAt: now })
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Search local long-term memory by key, content, or tags. Use at the start of a task when prior user preferences or durable project facts may be relevant.',
    parameters: {
      query: { type: 'string', required: true, description: 'Words or substring to search for.' },
      limit: { type: 'number', description: 'Maximum results, from 1 to 100. Defaults to 10.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const query = args.query.trim()
      if (!query || query.length > 1_000) throw new Error('memory query must contain 1 to 1000 characters')
      const limit = normalizeLimit(args.limit)
      const pattern = `%${query}%`
      return withDatabase(database => renderRows(database.prepare(`
        SELECT key, content, tags, created_at AS createdAt, updated_at AS updatedAt
        FROM memories
        WHERE key LIKE ? ESCAPE '\\' COLLATE NOCASE
           OR content LIKE ? ESCAPE '\\' COLLATE NOCASE
           OR tags LIKE ? ESCAPE '\\' COLLATE NOCASE
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(pattern, pattern, pattern, limit)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: 'List the most recently updated entries in local long-term memory.',
    parameters: {
      limit: { type: 'number', description: 'Maximum results, from 1 to 100. Defaults to 20.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const limit = normalizeLimit(args.limit, 20)
      return withDatabase(database => renderRows(database.prepare(`
        SELECT key, content, tags, created_at AS createdAt, updated_at AS updatedAt
        FROM memories
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(limit)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Delete one exact entry from local long-term memory. Use only when the user asks to forget that information or when correcting an obsolete memory.',
    parameters: {
      key: { type: 'string', required: true, description: 'Exact memory key to delete.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const key = args.key.trim()
      if (!key) throw new Error('memory key is required')
      return withDatabase(database => {
        const result = database.prepare('DELETE FROM memories WHERE key = ?').run(key)
        return JSON.stringify({ deleted: Number(result.changes) > 0, key })
      })
    },
  }))
}
