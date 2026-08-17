import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const ignoredDirectories = new Set(['.git', 'node_modules', 'build', 'coverage', 'dist'])
const forbiddenNames = [
  /^\.credentials\.ya?ml$/iu,
  /^settings\.ya?ml$/iu,
  /^(?:memory|sessions?|credentials?|accounts?|browser-profile|browser-output|automations?)$/iu,
  /\.(?:sqlite3?|db|gguf|safetensors|pem|key)$/iu,
]
const textExtensions = new Set(['', '.cjs', '.env', '.example', '.js', '.json', '.md', '.mjs', '.txt', '.yaml', '.yml'])
const contentChecks = [
  ['absolute macOS user path', /\/Users\/[A-Za-z0-9._-]+\//u],
  ['GitHub token', /\b(?:gh[opurs]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u],
  ['OpenAI-style secret', /\bsk-[A-Za-z0-9_-]{20,}\b/u],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/u],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['populated secret assignment', /\b(?:api[_-]?key|secret|password|token)\b\s*[:=]\s*["']?(?!\s|$|<|YOUR_|MY_)[A-Za-z0-9_./+@:-]{12,}/iu],
]

async function collect(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await collect(path, files)
    else if (entry.isFile()) files.push(path)
  }
  return files
}

const failures = []
for (const path of await collect(root)) {
  const projectPath = relative(root, path)
  const segments = projectPath.split(/[\\/]/u)
  if (segments.some(segment => forbiddenNames.some(pattern => pattern.test(segment)))) {
    failures.push(`${projectPath}: forbidden private/runtime filename`)
    continue
  }
  if (projectPath === 'scripts/security-check.mjs') continue
  if (!textExtensions.has(extname(path).toLowerCase())) continue
  const content = await readFile(path, 'utf8')
  for (const [label, pattern] of contentChecks) {
    if (pattern.test(content)) failures.push(`${projectPath}: ${label}`)
  }
}

if (failures.length > 0) {
  process.stderr.write(`Security check failed:\n- ${failures.join('\n- ')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('Security check passed: no credentials, private runtime files, or personal paths detected.\n')
}
