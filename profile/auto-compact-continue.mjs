const PLUGIN_ID = 'auto-compact-continue'
const CONTINUE_TEXT = 'Continue exactly where the previous response was truncated. Do not repeat completed content. Finish the original task.'

export const name = PLUGIN_ID
export const inject = ['compaction']

export function stepFinishedAtMaxTokens(session, turn) {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event.type === 'assistant/chunk' && event.data.turn === turn) {
      return event.data.chunk?.type === 'finish'
        && event.data.chunk.reason?.kind === 'max-tokens'
    }
    if (event.type === 'turn/start' && event.data.turn === turn) return false
  }
  return false
}

function continuationMessage() {
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text: CONTINUE_TEXT }]),
    source: Object.freeze({ kind: 'plugin', plugin: PLUGIN_ID }),
  })
}

export function apply(ctx) {
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (signal.aborted || !stepFinishedAtMaxTokens(agent.session, turn)) return
    try {
      const result = await ctx.compaction.compactIfNeeded(agent, 'pressure', signal)
      if (result === null || signal.aborted) return
      agent.steer(continuationMessage())
      ctx.logger.info(
        `auto compact/continue: shadowed ${result.shadowedSeqs.length} surface nodes `
        + `after max-token truncation in turn ${turn}`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`auto compact/continue skipped: ${message}`)
    }
  })
}
