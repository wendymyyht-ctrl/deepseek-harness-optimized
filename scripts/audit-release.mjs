import { access, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const textExtensions = new Set([
  '', '.cjs', '.css', '.env', '.html', '.js', '.json', '.jsx', '.md', '.mjs',
  '.sh', '.svg', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
])
const secretChecks = [
  ['GitHub token', /\b(?:gh[opurs]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u],
  ['OpenAI-style secret', /\bsk-[A-Za-z0-9_-]{20,}\b/u],
  ['AWS access key', /\bAKIA(?!IOSFODNN7EXAMPLE)[0-9A-Z]{16}\b/u],
  [
    'embedded private key',
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{80,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  ],
]

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

const buildMachineRoots = [...new Set([homedir(), process.env.USERPROFILE].filter(Boolean))]
  .map(path => new RegExp(`${escaped(path)}(?:[/\\\\]|$)`, 'u'))

async function collect(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await collect(path, files)
    else if (entry.isFile()) files.push(path)
  }
  return files
}

export async function auditReleaseTree(root) {
  const failures = []
  for (const path of await collect(root)) {
    if (!textExtensions.has(extname(path).toLowerCase())) continue
    if ((await stat(path)).size > 16 * 1024 * 1024) continue
    const content = await readFile(path, 'utf8')
    for (const pattern of buildMachineRoots) {
      if (pattern.test(content)) failures.push(`${relative(root, path)}: build-machine home path`)
    }
    const projectPath = relative(root, path)
    const thirdParty = projectPath.split(/[\\/]/u).some(segment => segment === 'node_modules' || segment === 'vendor')
    if (thirdParty) continue
    for (const [label, pattern] of secretChecks) {
      if (pattern.test(content)) failures.push(`${relative(root, path)}: ${label}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`Release privacy audit failed:\n- ${failures.join('\n- ')}`)
  }
  return { root, filesChecked: (await collect(root)).length }
}

async function existingReleaseRoots() {
  const candidates = [
    join(repositoryRoot, 'build', 'macos-arm64', 'DeepSeek Harness Optimized.app', 'Contents', 'Resources', 'app'),
    join(repositoryRoot, 'build', 'windows-x64', 'app'),
  ]
  const found = []
  for (const path of candidates) {
    try {
      await access(path)
      found.push(path)
    } catch {}
  }
  return found
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const roots = await existingReleaseRoots()
  if (roots.length === 0) throw new Error('No staged macOS or Windows release tree was found')
  for (const root of roots) {
    const result = await auditReleaseTree(root)
    process.stdout.write(`Release privacy audit passed: ${relative(repositoryRoot, root)} (${result.filesChecked} files)\n`)
  }
}
