import {
  cronMatches,
  executeTask,
  readTaskState,
  readTasks,
  runnerDescription,
  scheduleBucket,
} from './automation-core-local.mjs'

const home = process.env.DSH_AUTOMATION_HOME
const active = new Set()
let checking = false

async function checkSchedules(now = new Date()) {
  if (checking) return
  checking = true
  try {
    const tasks = await readTasks(home)
    for (const task of tasks) {
      if (!task.enabled || active.has(task.id) || !cronMatches(task.cron, now, task.timeZone)) continue
      const bucket = scheduleBucket(now, task.timeZone)
      const state = await readTaskState(task.id, home)
      if (state?.lastBucket === bucket) continue
      active.add(task.id)
      process.stdout.write(`[automation] starting ${runnerDescription(task)}\n`)
      executeTask(task, { home, bucket, trigger: 'schedule', capture: false })
        .then(result => process.stdout.write(`[automation] ${task.id} ${result.status}\n`))
        .catch(error => process.stderr.write(`[automation] ${task.id} failed: ${error}\n`))
        .finally(() => active.delete(task.id))
    }
  } catch (error) {
    process.stderr.write(`[automation] schedule check failed: ${error?.stack || error}\n`)
  } finally {
    checking = false
  }
}

await checkSchedules()
const interval = setInterval(() => { void checkSchedules() }, 15_000)

function shutdown() {
  clearInterval(interval)
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
