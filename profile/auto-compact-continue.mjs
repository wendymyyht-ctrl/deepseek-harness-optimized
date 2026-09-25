export const name = 'auto-compact-continue'
export const inject = ['compaction']
const CONTINUE_TEXT = 'Continue exactly where the previous response was truncated. Do not repeat completed content. Finish the original task.'
export function isTruncated(event) {
  if(event.type !== 'assistant/message') return false
  const finish = [...event.data.stream].reverse().find(record => record.type === 'chunk' && record.chunk.type === 'finish')
  return finish?.chunk.reason?.kind === 'max-tokens'
}
export function apply(ctx) {
  const endings = new WeakMap()
  ctx.on('session/event', (session,event) => {
    if(event.type === 'assistant/message') endings.set(session,{turn:event.data.turn,truncated:isTruncated(event)})
  })
  ctx.on('agent/turn-stopping', async ({agent,turn,signal}) => {
    const ending=endings.get(agent.session)
    if(signal.aborted || ending?.turn !== turn || !ending.truncated) return
    endings.delete(agent.session)
    try {
      const result=await ctx.compaction.compactIfNeeded(agent,'pressure',signal)
      if(result===null || signal.aborted) return
      agent.steer({id:crypto.randomUUID(),role:'user',content:[{type:'text',text:CONTINUE_TEXT}],source:{kind:'plugin',plugin:name}})
      ctx.logger.info('auto compact/continue: resumed after output truncation')
    } catch(error) {ctx.logger.warn('auto compact/continue skipped: '+String(error))}
  })
}
