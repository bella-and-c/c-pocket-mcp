import { fetchSafeResource } from './safe-fetch.js'

const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MAX_FEED_BYTES = 1536 * 1024
const DEFAULT_MAX_ENTRIES = 30

export class PocketRssReader {
  constructor({ store, timeoutMs, maxFeedBytes, allowPrivateHosts = false }) {
    this.store = store
    this.timeoutMs = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS)
    this.maxFeedBytes = positiveInteger(maxFeedBytes, DEFAULT_MAX_FEED_BYTES)
    this.allowPrivateHosts = allowPrivateHosts === true
  }

  async refresh({ feedIds, maxEntriesPerFeed = DEFAULT_MAX_ENTRIES } = {}) {
    const wanted = new Set(Array.isArray(feedIds) ? feedIds.filter(Boolean) : [])
    const feeds = (await this.store.listFeeds({ enabled: true }))
      .filter((feed) => !wanted.size || wanted.has(feed.id))
    const limit = Math.max(1, Math.min(100, Number(maxEntriesPerFeed) || DEFAULT_MAX_ENTRIES))
    const results = await mapWithConcurrency(feeds, 3, async (feed) => {
      const fetchedAt = new Date().toISOString()
      try {
        const response = await fetchSafeResource(feed.url, {
          timeoutMs: this.timeoutMs,
          maxBytes: this.maxFeedBytes,
          allowPrivateHosts: this.allowPrivateHosts,
          headers: {
            accept: 'application/atom+xml,application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.2',
            'user-agent': 'C-Pocket-RSS/2.6 (+https://github.com/bella-and-c/c-pocket-mcp)',
          },
        })
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`RSS source returned HTTP ${response.status}.`)
        }
        const parsed = parseRssDocument(response.body.toString('utf8'), response.url, limit)
        const saved = await this.store.recordRefresh(feed.id, { ...parsed, fetchedAt })
        return {
          feedId: feed.id,
          name: feed.name,
          ok: true,
          fetched: parsed.entries.length,
          added: saved.added,
          updated: saved.updated,
          skipped: saved.skipped,
        }
      } catch (error) {
        await this.store.recordFailure(feed.id, error.message, fetchedAt)
        return { feedId: feed.id, name: feed.name, ok: false, error: error.message }
      }
    })
    return {
      feeds: results,
      succeeded: results.filter((entry) => entry.ok).length,
      failed: results.filter((entry) => !entry.ok).length,
      added: results.reduce((sum, entry) => sum + (entry.added || 0), 0),
    }
  }
}

export function parseRssDocument(xml, baseUrl, maxEntries = DEFAULT_MAX_ENTRIES) {
  const source = String(xml || '').replace(/^\uFEFF/, '')
  if (!source.trim()) throw new Error('RSS source returned an empty document.')
  const atomBlocks = collectBlocks(source, 'entry')
  const rssBlocks = collectBlocks(source, 'item')
  const blocks = atomBlocks.length ? atomBlocks : rssBlocks
  if (!blocks.length) throw new Error('The response is not a supported RSS or Atom feed.')

  const headerIndexes = [
    source.search(/<(?:[\w.-]+:)?entry\b/i),
    source.search(/<(?:[\w.-]+:)?item\b/i),
  ].filter((index) => index >= 0)
  const headerEnd = headerIndexes.length ? Math.min(...headerIndexes) : source.length
  const feedTitle = textValue(source.slice(0, headerEnd), ['title']).slice(0, 240)
  const entries = blocks.slice(0, Math.max(1, Math.min(100, Number(maxEntries) || DEFAULT_MAX_ENTRIES)))
    .map((block) => parseEntry(block, baseUrl, feedTitle, atomBlocks.length > 0))
    .filter((entry) => entry.title || entry.url)

  if (!entries.length) throw new Error('The RSS feed did not contain usable entries.')
  return { feedTitle, entries }
}

function parseEntry(block, baseUrl, feedTitle, atom) {
  const title = textValue(block, ['title']).slice(0, 500)
  const summary = textValue(block, atom
    ? ['summary', 'content', 'content:encoded', 'description']
    : ['content:encoded', 'description', 'summary', 'content']).slice(0, 5000)
  const author = textValue(block, ['author', 'dc:creator', 'creator']).slice(0, 240)
  const published = textValue(block, ['published', 'pubDate', 'updated', 'dc:date', 'date'])
  const source = textValue(block, ['source']).slice(0, 240) || feedTitle
  const link = atom ? atomLink(block) : textValue(block, ['link'])
  const guid = textValue(block, ['guid', 'id'])
  return {
    title,
    url: resolveHttpUrl(link || guid, baseUrl),
    summary,
    author,
    source,
    publishedAt: parseDate(published),
  }
}

function collectBlocks(xml, localName) {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${escapeRegex(localName)}\\b[^>]*>[\\s\\S]*?<\\/(?:[\\w.-]+:)?${escapeRegex(localName)}\\s*>`,
    'gi',
  )
  return xml.match(pattern) || []
}

function textValue(xml, names) {
  for (const name of names) {
    const escaped = escapeRegex(name)
    const pattern = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}\\s*>`, 'i')
    const match = pattern.exec(xml)
    if (match) return cleanMarkup(match[1])
    if (!name.includes(':')) {
      const namespaced = new RegExp(`<(?:[\\w.-]+:)${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)${escaped}\\s*>`, 'i')
      const namespacedMatch = namespaced.exec(xml)
      if (namespacedMatch) return cleanMarkup(namespacedMatch[1])
    }
  }
  return ''
}

function atomLink(block) {
  const tags = block.match(/<link\b[^>]*>/gi) || []
  for (const tag of tags) {
    const rel = attributeValue(tag, 'rel').toLowerCase()
    const href = attributeValue(tag, 'href')
    if (href && (!rel || rel === 'alternate')) return decodeXml(href)
  }
  return textValue(block, ['link'])
}

function attributeValue(tag, name) {
  const match = new RegExp(`\\b${escapeRegex(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return match ? (match[1] ?? match[2] ?? '') : ''
}

function cleanMarkup(value) {
  return decodeXml(String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal) => safeCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

function safeCodePoint(value) {
  try { return Number.isInteger(value) ? String.fromCodePoint(value) : '' }
  catch { return '' }
}

function resolveHttpUrl(value, baseUrl) {
  try {
    const url = new URL(String(value || '').trim(), baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return ''
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

function parseDate(value) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

async function mapWithConcurrency(values, concurrency, operation) {
  const results = new Array(values.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next
      next += 1
      results[index] = await operation(values[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function positiveInteger(value, fallback) {
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
