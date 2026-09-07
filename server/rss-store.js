import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const EMPTY_STORE = { schemaVersion: 1, updatedAt: null, feeds: [], entries: [] }
const CATEGORIES = new Set(['science', 'ai', 'anime', 'other'])
const LANGUAGES = new Set(['zh', 'en', 'ja', 'mixed', 'other'])
const MAX_ENTRIES = 1500
const ENTRY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

export const RSS_STARTER_FEEDS = Object.freeze([
  {
    name: 'NASA JPL News',
    url: 'https://www.jpl.nasa.gov/feeds/news/',
    category: 'science',
    language: 'en',
  },
  {
    name: 'arXiv · Artificial Intelligence',
    url: 'https://rss.arxiv.org/rss/cs.AI',
    category: 'ai',
    language: 'en',
  },
  {
    name: 'Hugging Face Blog',
    url: 'https://huggingface.co/blog/feed.xml',
    category: 'ai',
    language: 'en',
  },
  {
    name: 'Anime News Network',
    url: 'https://www.animenewsnetwork.com/news/rss.xml?ann-edition=us',
    category: 'anime',
    language: 'en',
  },
  {
    name: 'AI · 中文聚合',
    url: googleNewsUrl('(人工智能 OR 大模型 OR 生成式AI) when:1d'),
    category: 'ai',
    language: 'zh',
  },
  {
    name: '科学 · 中文聚合',
    url: googleNewsUrl('(科学 OR 航天 OR 天文 OR 物理 OR 生物) when:1d'),
    category: 'science',
    language: 'zh',
  },
  {
    name: '动漫 · 中文聚合',
    url: googleNewsUrl('(动漫 OR 动画 OR 漫画 OR 新番) when:1d'),
    category: 'anime',
    language: 'zh',
  },
])

export class RssStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir)
    this.filePath = path.join(this.dataDir, 'rss-store.json')
    this.queue = Promise.resolve()
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true })
    try {
      await this.#read()
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await this.#write(EMPTY_STORE)
    }
  }

  async listFeeds({ enabled } = {}) {
    const state = await this.#read()
    return state.feeds
      .filter((feed) => enabled === undefined || feed.enabled === enabled)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      .map(clone)
  }

  async installStarterPack() {
    return this.#mutate((state) => {
      const installed = []
      const existing = []
      for (const candidate of RSS_STARTER_FEEDS) {
        const normalized = normalizeFeed(candidate)
        const found = state.feeds.find((feed) => canonicalUrl(feed.url) === canonicalUrl(normalized.url))
        if (found) {
          found.enabled = true
          found.name = normalized.name
          found.category = normalized.category
          found.language = normalized.language
          found.updatedAt = new Date().toISOString()
          existing.push(clone(found))
          continue
        }
        state.feeds.push(normalized)
        installed.push(clone(normalized))
      }
      return { installed, existing, total: state.feeds.filter((feed) => feed.enabled).length }
    })
  }

  async addFeed(input) {
    return this.#mutate((state) => {
      const normalized = normalizeFeed(input)
      const found = state.feeds.find((feed) => canonicalUrl(feed.url) === canonicalUrl(normalized.url))
      if (found) {
        found.name = normalized.name
        found.category = normalized.category
        found.language = normalized.language
        found.enabled = true
        found.updatedAt = new Date().toISOString()
        return { feed: clone(found), created: false }
      }
      state.feeds.push(normalized)
      return { feed: clone(normalized), created: true }
    })
  }

  async setFeedEnabled(id, enabled) {
    return this.#mutate((state) => {
      const feed = state.feeds.find((entry) => entry.id === id)
      if (!feed) throw rssError(404, 'RSS feed not found.')
      feed.enabled = enabled === true
      feed.updatedAt = new Date().toISOString()
      return clone(feed)
    })
  }

  async recordRefresh(feedId, input) {
    return this.#mutate((state) => {
      const feed = state.feeds.find((entry) => entry.id === feedId)
      if (!feed) throw rssError(404, 'RSS feed not found.')
      const now = validIso(input.fetchedAt) ? input.fetchedAt : new Date().toISOString()
      feed.lastFetchedAt = now
      feed.lastSuccessAt = now
      feed.lastError = null
      if (clean(input.feedTitle)) feed.feedTitle = clean(input.feedTitle).slice(0, 240)
      feed.updatedAt = now
      let added = 0
      let updated = 0
      let skipped = 0
      for (const incoming of Array.isArray(input.entries) ? input.entries : []) {
        let entry
        try {
          entry = normalizeEntry(incoming, feed, now)
        } catch {
          skipped += 1
          continue
        }
        const index = state.entries.findIndex((current) => current.id === entry.id)
        if (index < 0) {
          state.entries.push(entry)
          added += 1
          continue
        }
        state.entries[index] = mergeEntry(state.entries[index], entry, now)
        updated += 1
      }
      pruneEntries(state, now)
      return { feed: clone(feed), added, updated, skipped }
    })
  }

  async recordFailure(feedId, errorMessage, fetchedAt = new Date().toISOString()) {
    return this.#mutate((state) => {
      const feed = state.feeds.find((entry) => entry.id === feedId)
      if (!feed) throw rssError(404, 'RSS feed not found.')
      feed.lastFetchedAt = fetchedAt
      feed.lastError = clean(errorMessage).slice(0, 500) || 'RSS refresh failed.'
      feed.updatedAt = fetchedAt
      return clone(feed)
    })
  }

  async listDigest({ limit = 12, categories, languages, maxAgeHours = 36 } = {}) {
    const state = await this.#read()
    const categorySet = normalizeFilter(categories, CATEGORIES)
    const languageSet = normalizeFilter(languages, LANGUAGES)
    const cutoff = Date.now() - clampNumber(maxAgeHours, 1, 24 * 30, 36) * 60 * 60 * 1000
    return state.entries
      .filter((entry) => !entry.deliveredAt)
      .filter((entry) => !categorySet.size || entry.categories.some((value) => categorySet.has(value)))
      .filter((entry) => !languageSet.size || entry.languages.some((value) => languageSet.has(value)))
      .filter((entry) => Date.parse(entry.publishedAt || entry.discoveredAt) >= cutoff)
      .sort((a, b) => (b.publishedAt || b.discoveredAt).localeCompare(a.publishedAt || a.discoveredAt))
      .slice(0, clampNumber(limit, 1, 50, 12))
      .map(publicEntry)
  }

  async markDelivered(ids) {
    return this.#mutate((state) => {
      const wanted = new Set(Array.isArray(ids) ? ids.map(clean).filter(Boolean) : [])
      const now = new Date().toISOString()
      const delivered = []
      for (const entry of state.entries) {
        if (!wanted.has(entry.id)) continue
        entry.deliveredAt ||= now
        delivered.push(publicEntry(entry))
      }
      return delivered
    })
  }

  async search(query, limit = 10) {
    const state = await this.#read()
    const terms = clean(query).toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return []
    return state.entries
      .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
      .filter(({ entry, score }) => score > 0 && entry.url)
      .sort((a, b) => b.score - a.score || (b.entry.publishedAt || '').localeCompare(a.entry.publishedAt || ''))
      .slice(0, clampNumber(limit, 1, 50, 10))
      .map(({ entry }) => publicEntry(entry))
  }

  async getEntry(id) {
    const state = await this.#read()
    const entry = state.entries.find((candidate) => candidate.id === id)
    return entry ? publicEntry(entry) : null
  }

  async #read() {
    const raw = await readFile(this.filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.feeds) || !Array.isArray(parsed.entries)) {
      throw new Error('RSS store is invalid.')
    }
    return parsed
  }

  async #write(state) {
    const next = { ...clone(state), updatedAt: new Date().toISOString() }
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8')
    await rename(temporary, this.filePath)
  }

  #mutate(operation) {
    const run = async () => {
      const state = await this.#read()
      const result = await operation(state)
      await this.#write(state)
      return result
    }
    this.queue = this.queue.then(run, run)
    return this.queue
  }
}

function normalizeFeed(input) {
  const now = new Date().toISOString()
  const url = validateFeedUrl(input?.url)
  return {
    id: clean(input?.id) || `feed-${digest(url).slice(0, 16)}`,
    name: clean(input?.name).slice(0, 160) || new URL(url).hostname,
    url,
    category: CATEGORIES.has(input?.category) ? input.category : 'other',
    language: LANGUAGES.has(input?.language) ? input.language : 'other',
    enabled: input?.enabled !== false,
    feedTitle: null,
    lastFetchedAt: null,
    lastSuccessAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }
}

function normalizeEntry(input, feed, now) {
  const url = canonicalUrl(input?.url)
  const title = clean(input?.title).replace(/\s+/g, ' ').slice(0, 500)
  if (!title && !url) throw rssError(400, 'RSS entry needs a title or URL.')
  const publishedAt = validIso(input?.publishedAt) ? new Date(input.publishedAt).toISOString() : null
  const key = url || `${title}\n${clean(input?.source) || feed.name}`
  return {
    id: `rss-${digest(key).slice(0, 24)}`,
    title: title || url,
    url,
    summary: clean(input?.summary).replace(/\s+/g, ' ').slice(0, 5000),
    author: clean(input?.author).replace(/\s+/g, ' ').slice(0, 240),
    source: clean(input?.source).replace(/\s+/g, ' ').slice(0, 240) || feed.feedTitle || feed.name,
    publishedAt,
    discoveredAt: now,
    lastSeenAt: now,
    deliveredAt: null,
    feedIds: [feed.id],
    categories: [feed.category],
    languages: [feed.language],
  }
}

function mergeEntry(current, incoming, now) {
  return {
    ...current,
    title: incoming.title.length >= current.title.length ? incoming.title : current.title,
    url: current.url || incoming.url,
    summary: incoming.summary.length >= current.summary.length ? incoming.summary : current.summary,
    author: current.author || incoming.author,
    source: current.source || incoming.source,
    publishedAt: current.publishedAt || incoming.publishedAt,
    lastSeenAt: now,
    feedIds: unique([...current.feedIds, ...incoming.feedIds]),
    categories: unique([...current.categories, ...incoming.categories]),
    languages: unique([...current.languages, ...incoming.languages]),
  }
}

function publicEntry(entry) {
  return clone(entry)
}

function pruneEntries(state, now) {
  const cutoff = Date.parse(now) - ENTRY_RETENTION_MS
  state.entries = state.entries
    .filter((entry) => !entry.deliveredAt || Date.parse(entry.lastSeenAt || entry.discoveredAt) >= cutoff)
    .sort((a, b) => (b.lastSeenAt || b.discoveredAt).localeCompare(a.lastSeenAt || a.discoveredAt))
    .slice(0, MAX_ENTRIES)
}

function scoreEntry(entry, terms) {
  const title = entry.title.toLowerCase()
  const summary = entry.summary.toLowerCase()
  const source = entry.source.toLowerCase()
  const labels = [...entry.categories, ...entry.languages].join(' ').toLowerCase()
  return terms.reduce((score, term) => score
    + (title.includes(term) ? 6 : 0)
    + (source.includes(term) ? 3 : 0)
    + (summary.includes(term) ? 1 : 0)
    + (labels.includes(term) ? 2 : 0), 0)
}

function validateFeedUrl(value) {
  let url
  try { url = new URL(clean(value)) }
  catch { throw rssError(400, 'A valid RSS feed URL is required.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw rssError(400, 'RSS feeds must use a credential-free HTTP(S) URL.')
  }
  if (url.href.length > 4096) throw rssError(400, 'RSS feed URL is too long.')
  return url.href
}

function canonicalUrl(value) {
  try {
    const url = new URL(clean(value))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return ''
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

function normalizeFilter(values, allowed) {
  return new Set((Array.isArray(values) ? values : []).filter((value) => allowed.has(value)))
}

function googleNewsUrl(query) {
  const url = new URL('https://news.google.com/rss/search')
  url.searchParams.set('q', query)
  url.searchParams.set('hl', 'zh-CN')
  url.searchParams.set('gl', 'CN')
  url.searchParams.set('ceid', 'CN:zh-Hans')
  return url.href
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function unique(values) {
  return [...new Set(values)]
}

function clampNumber(value, minimum, maximum, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.trunc(numeric)))
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function clone(value) {
  return structuredClone(value)
}

function rssError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}
