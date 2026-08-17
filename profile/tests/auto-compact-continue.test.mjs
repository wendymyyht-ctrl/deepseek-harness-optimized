import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, stepFinishedAtMaxTokens } from '../auto-compact-continue.mjs'

function sessionWithFinish(reason, turn = 1) {
  return {
    events: [
      { type: 'turn/start', data: { turn } },
      { type: 'assistant/chunk', data: { turn, chunk: { type: 'finish', reason: { kind: reason } } } },
      { type: 'step/end', data: { turn } },
    ],
  }
}

test('detects only max-token finishes', () => {
  assert.equal(stepFinishedAtMaxTokens(sessionWithFinish('max-tokens'), 1), true)
  assert.equal(stepFinishedAtMaxTokens(sessionWithFinish('stop'), 1), false)
})

test('compacts and queues a continuation after truncation', async () => {
  let stopping
  let steered
  const ctx = {
    on(event, handler) {
      assert.equal(event, 'agent/turn-stopping')
      stopping = handler
    },
    compaction: {
      async compactIfNeeded(_agent, trigger) {
        assert.equal(trigger, 'pressure')
        return { shadowedSeqs: [1, 2, 3] }
      },
    },
    logger: { info() {}, warn() {} },
  }
  apply(ctx)
  await stopping({
    agent: {
      session: sessionWithFinish('max-tokens'),
      steer(message) { steered = message },
    },
    turn: 1,
    signal: new AbortController().signal,
  })
  assert.equal(steered.role, 'user')
  assert.equal(steered.source.plugin, 'auto-compact-continue')
})

test('does not continue when compaction has nothing to compact', async () => {
  let stopping
  let steered
  const ctx = {
    on(_event, handler) { stopping = handler },
    compaction: { async compactIfNeeded() { return null } },
    logger: { info() {}, warn() {} },
  }
  apply(ctx)
  await stopping({
    agent: {
      session: sessionWithFinish('max-tokens'),
      steer(message) { steered = message },
    },
    turn: 1,
    signal: new AbortController().signal,
  })
  assert.equal(steered, undefined)
})
