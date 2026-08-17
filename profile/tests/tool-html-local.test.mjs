import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  apply,
  buildHtmlIndex,
  chooseHtmlProcessingMode,
  compareIndexes,
  extractBlocks,
  loadHtmlIndex,
  readHtmlSource,
  searchIndex,
} from '../tool-html-local.mjs'

const SAMPLE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <title>路线计划</title>
    <style>.hidden { display: none }</style>
  </head>
  <body>
    <main>
      <h1 id="route">伦敦路线</h1>
      <p>第一阶段经西安前往霍尔果斯。</p>
      <table><tr><th>城市</th><th>停留</th></tr><tr><td>伦敦</td><td>3 天</td></tr></table>
      <a href="/safety/checklist">安全检查表</a>
      <script>window.internalValue = "不应进入可见文本"</script>
    </main>
  </body>
</html>`

test('registers five bounded HTML tools and routing guidance', () => {
  const tools = new Map()
  const sections = []
  apply({
    tools: { register: tool => tools.set(tool.name, tool) },
    systemPrompt: { section: section => sections.push(section) },
  })
  assert.deepEqual([...tools.keys()], [
    'html_inspect', 'html_search', 'html_extract', 'html_read_source', 'html_compare',
  ])
  assert.match(sections[0].text, /processingMode="auto"/u)
})

test('uses the index normally and source reads for explicit/debug tasks', () => {
  const index = buildHtmlIndex(SAMPLE)
  assert.equal(chooseHtmlProcessingMode(index, '总结页面内容').selectedMode, 'indexed')
  assert.equal(chooseHtmlProcessingMode(index, '排查 DOM 结构的渲染 bug').selectedMode, 'full-source')
  assert.equal(chooseHtmlProcessingMode(index, '完整读取原始 HTML').selectedMode, 'full-source')
  assert.equal(chooseHtmlProcessingMode(index, '完整读取原始 HTML', 'indexed').selectedMode, 'indexed')
})

test('indexes visible content while keeping code separate', () => {
  const index = buildHtmlIndex(SAMPLE)
  assert.equal(index.metadata.title, '路线计划')
  assert.match(index.visibleBlocks.map(block => block.text).join('\n'), /伦敦 \| 3 天/u)
  assert.doesNotMatch(index.visibleBlocks.map(block => block.text).join('\n'), /internalValue/u)
  assert.equal(searchIndex(index, '霍尔果斯').matches[0].tag, 'p')
  assert.equal(searchIndex(index, 'internalValue', { scope: 'visible' }).matches.length, 0)
  assert.equal(searchIndex(index, 'internalValue', { scope: 'code' }).matches[0].tag, 'script')
})

test('returns bounded evidence and supports an explicit complete source read', () => {
  const index = buildHtmlIndex(SAMPLE)
  const match = searchIndex(index, '霍尔果斯').matches[0]
  const extracted = JSON.parse(extractBlocks(index, [match.blockId], {
    includeSource: true,
    maxChars: 4_000,
  }))
  assert.equal(extracted.blocks.length, 1)
  assert.match(extracted.blocks[0].source, /^<p>/u)

  const complete = JSON.parse(readHtmlSource(index, { mode: 'full', maxChars: 4_000 }))
  assert.equal(complete.wholeDocumentInResult, true)
  assert.equal(complete.rawHtml, SAMPLE)
})

test('compares parsed documents without returning both full inputs', () => {
  const before = buildHtmlIndex(SAMPLE, 'before.html')
  const after = buildHtmlIndex(SAMPLE.replace('3 天', '4 天'), 'after.html')
  const comparison = compareIndexes(before, after)
  assert.equal(comparison.summary.identicalSource, false)
  assert.ok(comparison.changed.length >= 1)
  assert.ok(JSON.stringify(comparison).length < 10_000)
})

test('loads a temporary HTML file and reuses its in-process index', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-html-test-'))
  const source = join(directory, 'sample.html')
  try {
    await writeFile(source, SAMPLE, 'utf8')
    const first = await loadHtmlIndex(source)
    const second = await loadHtmlIndex(source)
    assert.ok(first.index.bytes > 100)
    assert.equal(second.cacheHit, true)
    assert.equal(second.index.digest, first.index.digest)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
