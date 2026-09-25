import { WebError } from '@deepseek-ai/dsh-web'

const PROVIDER_ID = 'public-web'
const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/'
const SEARCH_TIMEOUT_MS = 20_000
const USER_AGENT = 'DeepSeek-Harness-Local/1.0'

function decodeHtml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

function textContent(html) {
  return decodeHtml(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
}

function resultUrl(rawHref) {
  const decoded = decodeHtml(rawHref)
  const parsed = new URL(decoded, SEARCH_ENDPOINT)
  if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname.startsWith('/l/')) {
    const destination = parsed.searchParams.get('uddg')
    if (destination) return resultUrl(destination)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  return parsed.href
}

function parseResults(html, maxResults) {
  const resultAnchors = []
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let match
  while ((match = anchorPattern.exec(html)) !== null) {
    const attributes = match[1]
    const classMatch = attributes.match(/\bclass=["']([^"']*)["']/i)
    if (!classMatch?.[1].split(/\s+/).includes('result__a')) continue
    const hrefMatch = attributes.match(/\bhref=["']([^"']+)["']/i)
    if (!hrefMatch) continue
    resultAnchors.push({ index: match.index, href: hrefMatch[1], title: match[2] })
  }

  const sources = []
  const seen = new Set()
  for (let index = 0; index < resultAnchors.length && sources.length < maxResults; index += 1) {
    const current = resultAnchors[index]
    const url = resultUrl(current.href)
    if (!url || seen.has(url)) continue
    const blockEnd = resultAnchors[index + 1]?.index ?? html.length
    const block = html.slice(current.index, blockEnd)
    const snippetMatch = block.match(/<a\b[^>]*\bclass=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)
    seen.add(url)
    sources.push({
      url,
      title: textContent(current.title) || url,
      ...(snippetMatch ? { snippet: textContent(snippetMatch[1]) } : {}),
    })
  }
  return sources
}

async function search(request, signal) {
  const maxResults = request.maxResults ?? 8
  const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  try {
    const response = await fetch(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': USER_AGENT,
      },
      body: new URLSearchParams({ q: request.query }),
      redirect: 'follow',
      signal: combinedSignal,
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
    const sources = parseResults(await response.text(), maxResults)
    return { sources, truncated: false }
  } catch (error) {
    if (signal?.aborted) {
      throw new WebError('Public web search aborted', 'WEB_ABORTED', { cause: error })
    }
    throw new WebError(`Public web search failed: ${error instanceof Error ? error.message : String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

export const name = 'web-search-public'
export const inject = ['web']

export function apply(ctx) {
  ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    available: () => true,
    search,
  })
}
