import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  openSync,
} from 'node:fs'
import {
  access,
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

export const DEFAULT_AUTOMATION_HOME = join(process.env.DSH_HOME || join(homedir(), '.dsh-optimized'), 'automations')
export const LAUNCH_AGENT_LABEL = 'io.github.deepseek-harness-optimized.automation-runner'
const STORE_VERSION = 1
const execFileAsync = promisify(execFile)

export function automationPaths(home = process.env.DSH_AUTOMATION_HOME || DEFAULT_AUTOMATION_HOME) {
  const root = resolve(home)
  return {
    root,
    tasks: join(root, 'tasks.json'),
    lock: join(root, '.tasks.lock'),
    states: join(root, 'states'),
    logs: join(root, 'logs'),
    runnerStdout: join(root, 'runner.stdout.log'),
    runnerStderr: join(root, 'runner.stderr.log'),
  }
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const number = Number(value ?? fallback)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return number
}

function validateTimeZone(value) {
  const timeZone = String(value ?? '').trim()
  if (!timeZone || timeZone.length > 120) throw new Error('timeZone must be a non-empty IANA time zone')
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone }).format(new Date(0))
  } catch {
    throw new Error(`invalid IANA time zone: ${timeZone}`)
  }
  return timeZone
}

function parseCronField(source, minimum, maximum, name, normalize = value => value) {
  const expression = String(source ?? '').trim()
  if (!expression) throw new Error(`${name} cron field is empty`)
  const values = new Set()
  for (const segment of expression.split(',')) {
    if (!segment) throw new Error(`invalid ${name} cron field: ${expression}`)
    const [rangeSource, stepSource, extra] = segment.split('/')
    if (extra !== undefined) throw new Error(`invalid ${name} cron field: ${expression}`)
    const step = stepSource === undefined ? 1 : Number(stepSource)
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid ${name} cron step: ${segment}`)
    let start
    let end
    if (rangeSource === '*') {
      start = minimum
      end = maximum
    } else {
      const match = rangeSource.match(/^(\d+)(?:-(\d+))?$/u)
      if (!match) throw new Error(`invalid ${name} cron field: ${expression}`)
      start = Number(match[1])
      end = Number(match[2] ?? match[1])
      if (start < minimum || end > maximum || start > end) {
        throw new Error(`${name} cron value must be from ${minimum} to ${maximum}`)
      }
    }
    for (let value = start; value <= end; value += step) values.add(normalize(value))
  }
  return { values, wildcard: expression === '*' }
}

export function parseCron(expression) {
  const parts = String(expression ?? '').trim().split(/\s+/u)
  if (parts.length !== 5) throw new Error('cron must have exactly five fields: minute hour day-of-month month day-of-week')
  return {
    expression: parts.join(' '),
    minute: parseCronField(parts[0], 0, 59, 'minute'),
    hour: parseCronField(parts[1], 0, 23, 'hour'),
    day: parseCronField(parts[2], 1, 31, 'day-of-month'),
    month: parseCronField(parts[3], 1, 12, 'month'),
    weekday: parseCronField(parts[4], 0, 7, 'day-of-week', value => value === 7 ? 0 : value),
  }
}

export function zonedDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: validateTimeZone(timeZone),
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  })
  const values = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: weekdays[values.weekday],
  }
}

export function cronMatches(expression, date, timeZone) {
  const cron = typeof expression === 'string' ? parseCron(expression) : expression
  const parts = zonedDateParts(date, timeZone)
  if (!cron.minute.values.has(parts.minute) || !cron.hour.values.has(parts.hour) || !cron.month.values.has(parts.month)) return false
  const dayMatches = cron.day.values.has(parts.day)
  const weekdayMatches = cron.weekday.values.has(parts.weekday)
  if (cron.day.wildcard && cron.weekday.wildcard) return true
  if (cron.day.wildcard) return weekdayMatches
  if (cron.weekday.wildcard) return dayMatches
  return dayMatches || weekdayMatches
}

export function scheduleBucket(date, timeZone) {
  const part = zonedDateParts(date, timeZone)
  const pad = value => String(value).padStart(2, '0')
  return `${part.year}-${pad(part.month)}-${pad(part.day)}T${pad(part.hour)}:${pad(part.minute)}@${timeZone}`
}

function normalizeTask(input, id = `auto_${randomUUID().replaceAll('-', '').slice(0, 16)}`) {
  const name = String(input.name ?? '').trim()
  if (!name || name.length > 160) throw new Error('name must contain 1 to 160 characters')
  const program = String(input.program ?? '').trim()
  if (!isAbsolute(program) || program.includes('\0')) throw new Error('program must be an absolute executable path')
  const args = Array.isArray(input.arguments) ? input.arguments.map(value => String(value)) : []
  if (args.length > 64 || args.some(value => value.length > 4096 || value.includes('\0'))) {
    throw new Error('arguments may contain at most 64 strings of at most 4096 characters each')
  }
  const cwd = input.cwd === undefined || input.cwd === '' ? dirname(program) : String(input.cwd).trim()
  if (!isAbsolute(cwd) || cwd.includes('\0')) throw new Error('cwd must be an absolute directory path')
  return {
    id,
    name,
    cron: parseCron(input.cron).expression,
    timeZone: validateTimeZone(input.timeZone),
    program,
    arguments: args,
    cwd,
    timeoutSeconds: boundedInteger(input.timeoutSeconds, 900, 5, 86400, 'timeoutSeconds'),
    enabled: input.enabled !== false,
  }
}

async function validateTaskPaths(task) {
  await access(task.program, fsConstants.X_OK).catch(() => {
    throw new Error(`program is not executable or does not exist: ${task.program}`)
  })
  const metadata = await stat(task.cwd).catch(() => undefined)
  if (!metadata?.isDirectory()) throw new Error(`cwd is not a directory: ${task.cwd}`)
}

async function ensureDirectories(home) {
  const paths = automationPaths(home)
  await Promise.all([
    mkdir(paths.root, { recursive: true, mode: 0o700 }),
    mkdir(paths.states, { recursive: true, mode: 0o700 }),
    mkdir(paths.logs, { recursive: true, mode: 0o700 }),
  ])
  return paths
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

async function withTaskLock(home, callback) {
  const paths = await ensureDirectories(home)
  let handle
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await import('node:fs/promises').then(module => module.open(paths.lock, 'wx', 0o600))
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const lockStat = await stat(paths.lock).catch(() => undefined)
      if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) await unlink(paths.lock).catch(() => {})
      await new Promise(resolveWait => setTimeout(resolveWait, 20))
    }
  }
  if (!handle) throw new Error('automation task store is busy')
  try {
    return await callback(paths)
  } finally {
    await handle.close().catch(() => {})
    await unlink(paths.lock).catch(() => {})
  }
}

export async function readTasks(home) {
  const paths = await ensureDirectories(home)
  let parsed
  try {
    parsed = JSON.parse(await readFile(paths.tasks, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw new Error(`unable to read automation task store: ${error}`)
  }
  if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.tasks)) throw new Error('invalid automation task store')
  return parsed.tasks.map(task => ({
    ...normalizeTask(task, task.id),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }))
}

async function saveTasks(path, tasks) {
  await atomicJson(path, { version: STORE_VERSION, updatedAt: new Date().toISOString(), tasks })
}

export async function createTask(input, home) {
  const task = normalizeTask(input)
  await validateTaskPaths(task)
  const now = new Date().toISOString()
  const stored = { ...task, createdAt: now, updatedAt: now }
  return withTaskLock(home, async paths => {
    const tasks = await readTasks(paths.root)
    tasks.push(stored)
    await saveTasks(paths.tasks, tasks)
    return stored
  })
}

export async function deleteTask(id, home) {
  const normalized = String(id ?? '').trim()
  if (!/^auto_[a-z0-9]{16}$/u.test(normalized)) throw new Error('invalid automation id')
  return withTaskLock(home, async paths => {
    const tasks = await readTasks(paths.root)
    const retained = tasks.filter(task => task.id !== normalized)
    if (retained.length === tasks.length) return false
    await saveTasks(paths.tasks, retained)
    return true
  })
}

export async function readTaskState(id, home) {
  const paths = await ensureDirectories(home)
  try {
    return JSON.parse(await readFile(join(paths.states, `${id}.json`), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writeTaskState(id, state, home) {
  const paths = await ensureDirectories(home)
  await atomicJson(join(paths.states, `${id}.json`), state)
}

function clippedAppend(current, chunk, maximum = 32_000) {
  if (current.length >= maximum) return current
  return current + chunk.toString('utf8').slice(0, maximum - current.length)
}

export async function executeTask(task, options = {}) {
  const home = options.home
  const startedAt = new Date().toISOString()
  const bucket = options.bucket ?? null
  await writeTaskState(task.id, {
    ...(await readTaskState(task.id, home) ?? {}),
    status: 'running',
    lastBucket: bucket,
    lastStartedAt: startedAt,
    lastTrigger: options.trigger ?? 'manual',
    pid: null,
  }, home)

  const paths = await ensureDirectories(home)
  const stdoutPath = join(paths.logs, `${task.id}.stdout.log`)
  const stderrPath = join(paths.logs, `${task.id}.stderr.log`)
  const capture = options.capture !== false
  const stdoutFd = capture ? undefined : openSync(stdoutPath, 'a', 0o600)
  const stderrFd = capture ? undefined : openSync(stderrPath, 'a', 0o600)
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let child
  try {
    child = spawn(task.program, task.arguments, {
      cwd: task.cwd,
      env: {
        ...process.env,
        PATH: process.platform === 'win32' ? process.env.PATH : [...new Set([
          '/opt/homebrew/bin',
          '/usr/local/bin',
          ...(process.env.PATH || '').split(':').filter(Boolean),
          '/usr/bin',
          '/bin',
          '/usr/sbin',
          '/sbin',
        ])].join(':'),
        DSH_AUTOMATION_ID: task.id,
        DSH_AUTOMATION_NAME: task.name,
      },
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', stdoutFd, stderrFd],
    })
    const state = await readTaskState(task.id, home) ?? {}
    await writeTaskState(task.id, { ...state, pid: child.pid }, home)
    if (capture) {
      child.stdout.on('data', chunk => { stdout = clippedAppend(stdout, chunk) })
      child.stderr.on('data', chunk => { stderr = clippedAppend(stderr, chunk) })
    }
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }, task.timeoutSeconds * 1000)
    timeout.unref()
    const result = await new Promise((resolveRun, rejectRun) => {
      child.once('error', rejectRun)
      child.once('close', (code, signal) => resolveRun({ code, signal }))
    })
    clearTimeout(timeout)
    const finishedAt = new Date().toISOString()
    if (capture) {
      const header = `\n[${startedAt}] ${task.name} (${options.trigger ?? 'manual'})\n`
      await Promise.all([
        appendFile(stdoutPath, `${header}${stdout}`, { mode: 0o600 }),
        appendFile(stderrPath, `${header}${stderr}`, { mode: 0o600 }),
      ])
    }
    const status = timedOut ? 'timed-out' : result.code === 0 ? 'succeeded' : 'failed'
    const previous = await readTaskState(task.id, home) ?? {}
    const finalState = {
      ...previous,
      status,
      pid: null,
      lastBucket: bucket,
      lastStartedAt: startedAt,
      lastFinishedAt: finishedAt,
      lastTrigger: options.trigger ?? 'manual',
      lastExitCode: result.code,
      lastSignal: result.signal,
      runs: Number(previous.runs ?? 0) + 1,
    }
    await writeTaskState(task.id, finalState, home)
    return { status, exitCode: result.code, signal: result.signal, startedAt, finishedAt, stdout, stderr }
  } catch (error) {
    const previous = await readTaskState(task.id, home) ?? {}
    await writeTaskState(task.id, {
      ...previous,
      status: 'failed',
      pid: null,
      lastBucket: bucket,
      lastStartedAt: startedAt,
      lastFinishedAt: new Date().toISOString(),
      lastTrigger: options.trigger ?? 'manual',
      lastError: String(error),
      runs: Number(previous.runs ?? 0) + 1,
    }, home)
    throw error
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd)
    if (stderrFd !== undefined) closeSync(stderrFd)
  }
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function launchAgentPlist({ nodePath, runnerPath, home }) {
  const paths = automationPaths(home)
  const argumentsXml = [nodePath, runnerPath]
    .map(value => `      <string>${xmlEscape(value)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DSH_AUTOMATION_HOME</key>
    <string>${xmlEscape(paths.root)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(paths.runnerStdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(paths.runnerStderr)}</string>
</dict>
</plist>
`
}

export async function ensureLaunchAgent({ nodePath, runnerPath, home } = {}) {
  if (process.platform !== 'darwin') throw new Error('durable automation currently requires macOS launchd')
  const resolvedNode = nodePath || process.execPath
  const resolvedRunner = resolve(runnerPath)
  await access(resolvedNode, fsConstants.X_OK)
  await access(resolvedRunner, fsConstants.R_OK)
  const paths = await ensureDirectories(home)
  const launchAgents = join(homedir(), 'Library', 'LaunchAgents')
  await mkdir(launchAgents, { recursive: true, mode: 0o700 })
  const plistPath = join(launchAgents, `${LAUNCH_AGENT_LABEL}.plist`)
  const content = launchAgentPlist({ nodePath: resolvedNode, runnerPath: resolvedRunner, home: paths.root })
  const previous = await readFile(plistPath, 'utf8').catch(() => '')
  if (previous !== content) await writeFile(plistPath, content, { mode: 0o600 })

  const domain = `gui/${process.getuid()}`
  const service = `${domain}/${LAUNCH_AGENT_LABEL}`
  let loaded = true
  try {
    await execFileAsync('/bin/launchctl', ['print', service], { timeout: 5_000 })
  } catch {
    loaded = false
  }
  if (!loaded) {
    await execFileAsync('/bin/launchctl', ['bootstrap', domain, plistPath], { timeout: 10_000 })
    await execFileAsync('/bin/launchctl', ['kickstart', service], { timeout: 10_000 }).catch(() => {})
  } else if (previous !== content) {
    await execFileAsync('/bin/launchctl', ['bootout', service], { timeout: 10_000 }).catch(() => {})
    await execFileAsync('/bin/launchctl', ['bootstrap', domain, plistPath], { timeout: 10_000 })
  }
  return { label: LAUNCH_AGENT_LABEL, plistPath, loaded: true, runnerHome: paths.root }
}

export async function listTasksWithState(home) {
  const tasks = await readTasks(home)
  return Promise.all(tasks.map(async task => ({ ...task, state: await readTaskState(task.id, home) })))
}

export function compactTask(task) {
  return {
    id: task.id,
    name: task.name,
    cron: task.cron,
    timeZone: task.timeZone,
    command: [task.program, ...task.arguments],
    cwd: task.cwd,
    timeoutSeconds: task.timeoutSeconds,
    enabled: task.enabled,
    createdAt: task.createdAt,
    state: task.state ?? undefined,
  }
}

export function runnerDescription(task) {
  return `${task.name}: ${task.cron} (${task.timeZone}) → ${basename(task.program)} ${task.arguments.join(' ')}`.trim()
}
