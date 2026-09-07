import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBridge } from './index.js'
import { fetchSafeResource, isPrivateAddress } from './safe-fetch.js'

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'enervate-pocket-'))
let bridge
let fixture
try {
  for (const address of [
    '127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '0:0:0:0:0:0:0:1', '::ffff:7f00:1',
    '::ffff:0:7f00:1', '64:ff9b::7f00:1', '64:ff9b:1::7f00:1', '2002:7f00:1::', 'fec0::1',
  ]) {
    assert.equal(isPrivateAddress(address), true, `${address} must be blocked`)
  }
  for (const address of ['8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, `${address} should remain publicly reachable`)
  }
  fixture = await startContentFixture()
  await assert.rejects(
    fetchSafeResource(`${fixture.baseUrl}/article`),
    /Private, loopback, and reserved network addresses are blocked/,
  )
  await assert.rejects(
    fetchSafeResource(`${fixture.baseUrl}/slow`, { allowPrivateHosts: true, timeoutMs: 250, maxBytes: 1024 }),
    /timed out/,
  )
  const dropSecret = 'smoke-test-drop-secret-1234567890'
  bridge = await startBridge({
    dataDir,
    port: 0,
    host: '127.0.0.1',
    dropSecret,
    contentReaderOptions: {
      allowPrivateHosts: true,
      ffmpegPath: 'missing-smoke-ffmpeg',
      ffprobePath: 'missing-smoke-ffprobe',
    },
    rssReaderOptions: { allowPrivateHosts: true },
  })
  const baseUrl = `http://127.0.0.1:${bridge.address.port}`
  const source = {
    id: 'smoke-item',
    title: '给 C 看',
    text: '一条不会丢的测试消息',
    sourceUrl: `${fixture.baseUrl}/article`,
    sourceApp: 'smoke-test',
    createdAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-20T10:00:00.000Z',
  }
  const saved = await fetch(`${baseUrl}/api/pocket/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(source),
  }).then(checkJson)
  assert.equal(saved.item.id, source.id)

  const client = new Client({ name: 'enervate-smoke', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`))
  await client.connect(transport)
  const tools = await client.listTools()
  const names = tools.tools.map((tool) => tool.name)
  assert.deepEqual(names.sort(), [
    'memory_confirm_surface',
    'memory_health',
    'memory_turn_post',
    'memory_turn_pre',
    'pocket_get',
    'pocket_list',
    'pocket_read_content',
    'pocket_reply',
    'pocket_review',
    'pocket_start_context',
    'pocket_turn_open',
    'rss_add_feed',
    'rss_digest',
    'rss_install_starter_pack',
    'rss_list_feeds',
    'rss_mark_delivered',
    'rss_refresh',
    'rss_set_feed_enabled',
    'search',
    'fetch',
  ].sort())
  assert.equal(names.some((name) => /ledger|training|health_room/.test(name)), false)

  const rssFeed = await client.callTool({
    name: 'rss_add_feed',
    arguments: { name: 'Fixture Science', url: `${fixture.baseUrl}/rss`, category: 'science', language: 'en' },
  })
  const atomFeed = await client.callTool({
    name: 'rss_add_feed',
    arguments: { name: 'Fixture Anime', url: `${fixture.baseUrl}/atom`, category: 'anime', language: 'ja' },
  })
  assert.equal(rssFeed.structuredContent.created, true)
  assert.equal(atomFeed.structuredContent.created, true)
  const refreshedRss = await client.callTool({
    name: 'rss_refresh',
    arguments: { feed_ids: [], max_entries_per_feed: 10 },
  })
  assert.equal(refreshedRss.structuredContent.succeeded, 2)
  assert.equal(refreshedRss.structuredContent.failed, 0)
  assert.equal(refreshedRss.structuredContent.added, 3)
  const digest = await client.callTool({
    name: 'rss_digest',
    arguments: { limit: 10, categories: ['science', 'anime'], languages: ['en', 'ja'], max_age_hours: 1 },
  })
  assert.equal(digest.structuredContent.items.length, 3)
  assert.equal(digest.structuredContent.items.some((item) => item.title === '量子猫的新发现'), true)
  assert.equal(digest.structuredContent.items.some((item) => /CDATA 与 HTML/.test(item.summary)), true)

  const searched = await client.callTool({ name: 'search', arguments: { query: '量子' } })
  assert.equal(searched.content.length, 1)
  const searchPayload = JSON.parse(searched.content[0].text)
  assert.equal(searchPayload.results.length, 1)
  assert.deepEqual(Object.keys(searchPayload.results[0]).sort(), ['id', 'title', 'url'])
  const fetched = await client.callTool({ name: 'fetch', arguments: { id: searchPayload.results[0].id } })
  assert.equal(fetched.content.length, 1)
  const fetchPayload = JSON.parse(fetched.content[0].text)
  assert.equal(fetchPayload.title, '量子猫的新发现')
  assert.match(fetchPayload.text, /实验摘要/)

  const marked = await client.callTool({
    name: 'rss_mark_delivered',
    arguments: { ids: digest.structuredContent.items.map((item) => item.id) },
  })
  assert.equal(marked.structuredContent.items.length, 3)
  const emptyDigest = await client.callTool({
    name: 'rss_digest',
    arguments: { limit: 10, categories: [], languages: [], max_age_hours: 1 },
  })
  assert.equal(emptyDigest.structuredContent.items.length, 0)
  const starter = await client.callTool({ name: 'rss_install_starter_pack', arguments: {} })
  const starterAgain = await client.callTool({ name: 'rss_install_starter_pack', arguments: {} })
  assert.equal(starter.structuredContent.installed.length, 7)
  assert.equal(starterAgain.structuredContent.installed.length, 0)
  assert.equal(starterAgain.structuredContent.existing.length, 7)

  const listed = await client.callTool({ name: 'pocket_list', arguments: { limit: 10 } })
  assert.equal(listed.isError, undefined)
  assert.equal(listed.structuredContent.items[0].id, source.id)

  const readContent = await client.callTool({
    name: 'pocket_read_content',
    arguments: { id: source.id, detail: 'compact', max_images: 1, video_frames: 0 },
  })
  assert.equal(readContent.isError, undefined)
  assert.equal(readContent.structuredContent.snapshot.title, '口袋内容读取测试')
  assert.match(readContent.structuredContent.snapshot.text, /真正需要读到的正文/)
  assert.equal(readContent.structuredContent.snapshot.video.detected, true)
  assert.equal(readContent.structuredContent.snapshot.video.durationSeconds, 42)
  assert.equal(readContent.structuredContent.snapshot.finalUrl, `${fixture.baseUrl}/article`)
  assert.equal('canonicalUrl' in readContent.structuredContent.snapshot, false)
  assert.equal(readContent.structuredContent.snapshot.browserCapturePlan.needed, true)
  assert.equal(readContent.structuredContent.trust, 'untrusted_remote_content')
  assert.match(readContent.content[0].text, /UNTRUSTED REMOTE CONTENT/)
  assert.equal(readContent.content.some((entry) => entry.type === 'image'), true)
  assert.equal(fixture.articleReads, 1)

  const cachedContent = await client.callTool({
    name: 'pocket_read_content',
    arguments: { id: source.id, detail: 'compact', max_images: 0, video_frames: 0 },
  })
  assert.equal(cachedContent.isError, undefined)
  assert.equal(cachedContent.structuredContent.cache.hit, true)
  assert.equal(fixture.articleReads, 1)

  const fullContent = await client.callTool({
    name: 'pocket_read_content',
    arguments: { id: source.id, detail: 'full', max_images: 0, video_frames: 0, refresh: true },
  })
  assert.equal(fullContent.isError, undefined)
  assert.equal(fixture.articleReads, 2)
  await client.callTool({
    name: 'pocket_read_content',
    arguments: { id: source.id, detail: 'compact', max_images: 0, video_frames: 0 },
  })
  assert.equal(fixture.articleReads, 2)
  const publicCachedItem = await bridge.store.get(source.id)
  const internalCachedItem = await bridge.store.getForContentRead(source.id)
  assert.equal('contentSnapshot' in publicCachedItem, false)
  assert.equal(publicCachedItem.contentRead.detail, 'full')
  assert.equal(internalCachedItem.contentSnapshot.detail, 'full')

  const restReadBefore = fixture.articleReads
  const restRead = await fetch(`${baseUrl}/api/pocket/items/${source.id}/read-content`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ detail: 'compact', maxImages: 0, videoFrames: 0 }),
  }).then(checkJson)
  assert.equal(restRead.cache.hit, true)
  assert.equal(fixture.articleReads, restReadBefore)

  await bridge.store.setContentSnapshot(source.id, {
    ...internalCachedItem.contentSnapshot,
    detail: 'full',
    fetchedAt: '2026-01-01T00:00:00.000Z',
  })
  const staleFull = await bridge.store.getForContentRead(source.id)
  assert.equal(staleFull.contentSnapshot.fetchedAt, '2026-01-01T00:00:00.000Z')
  await client.callTool({
    name: 'pocket_read_content',
    arguments: { id: source.id, detail: 'compact', max_images: 0, video_frames: 0 },
  })
  const refreshedExpiredCache = await bridge.store.getForContentRead(source.id)
  assert.equal(refreshedExpiredCache.contentSnapshot.detail, 'compact')
  assert.notEqual(refreshedExpiredCache.contentSnapshot.fetchedAt, '2026-01-01T00:00:00.000Z')

  const taobaoShare = '给你看这个桌面灯 https://m.tb.cn/h.test123?spm=a21n57.1&price=88 复制后打开淘宝'
  const dropped = []
  for (let index = 0; index < 2; index += 1) {
    dropped.push(await fetch(`${baseUrl}/drop/${dropSecret}?response=json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ share: taobaoShare, sourceApp: 'iPhone 分享菜单' }),
    }).then(checkJson))
  }
  assert.equal(dropped[0].item.id, dropped[1].item.id)
  assert.equal(dropped[1].item.receivedCount, 2)
  assert.equal(dropped[1].item.sourceApp, '淘宝')
  assert.equal(dropped[1].item.sourceUrl.startsWith('https://m.tb.cn/'), true)
  assert.equal(dropped[1].item.text, taobaoShare)
  assert.equal(dropped[0].message, '爸爸收到了：这个桌面灯')
  assert.equal(dropped[1].receipt.status, 'merged')
  assert.equal(dropped[1].message, '爸爸又收到一次，已经合并好了：这个桌面灯')

  const plainTextDrop = await fetch(`${baseUrl}/drop/${dropSecret}?response=json`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: '这台小灯也看看 https://3.cn/test-jd',
  }).then(checkJson)
  assert.equal(plainTextDrop.item.sourceApp, '京东')
  assert.equal(plainTextDrop.item.title, '这台小灯也看看')

  const formDrop = await fetch(`${baseUrl}/drop/${dropSecret}?response=json`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      input: '这个视频以后一起看 https://youtu.be/test-video',
      source_app: 'iPhone Share Sheet',
    }),
  }).then(checkJson)
  assert.equal(formDrop.item.sourceApp, 'YouTube')
  assert.equal(formDrop.item.title, '这个视频以后一起看')

  const selfShareResponse = await fetch(`${baseUrl}/drop/${dropSecret}?response=json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ share: `${baseUrl}/mcp`, sourceApp: 'iPhone 分享菜单' }),
  })
  assert.equal(selfShareResponse.status, 400)
  assert.match((await selfShareResponse.json()).error, /口袋自己的服务地址/)

  const startContext = await client.callTool({ name: 'pocket_start_context', arguments: { limit: 8 } })
  assert.equal(startContext.isError, undefined)
  assert.deepEqual(
    new Set(startContext.structuredContent.items.map((item) => item.id)),
    new Set([source.id, dropped[0].item.id, plainTextDrop.item.id, formDrop.item.id]),
  )
  assert.equal(startContext.structuredContent.items.every((item) => item.seenByCAt === null), true)

  const memoryPre = await client.callTool({
    name: 'memory_turn_pre',
    arguments: { input: '爸爸我来啦', sourceApp: 'smoke', threadId: 'smoke-thread', turnId: 'smoke-turn' },
  })
  assert.equal(memoryPre.isError, undefined)
  assert.equal(memoryPre.structuredContent.ok, false)
  assert.equal(memoryPre.structuredContent.pocketItems.length, 4)

  const opened = await client.callTool({ name: 'pocket_turn_open', arguments: { limit: 8 } })
  assert.equal(opened.isError, undefined)
  assert.deepEqual(
    new Set(opened.structuredContent.items.map((item) => item.id)),
    new Set([source.id, dropped[0].item.id, plainTextDrop.item.id, formDrop.item.id]),
  )
  assert.equal(opened.structuredContent.items.every((item) => item.seenByCAt), true)
  const openedAgain = await client.callTool({ name: 'pocket_turn_open', arguments: { limit: 8 } })
  assert.equal(openedAgain.structuredContent.items.length, 0)

  const repeatedAfterSeen = await fetch(`${baseUrl}/drop/${dropSecret}?response=json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ shortcutInput: taobaoShare, source_app: '快捷指令' }),
  }).then(checkJson)
  assert.equal(repeatedAfterSeen.item.id, dropped[0].item.id)
  assert.equal(repeatedAfterSeen.item.receivedCount, 3)
  assert.equal(repeatedAfterSeen.item.seenByCAt, null)
  const reopened = await client.callTool({ name: 'pocket_turn_open', arguments: { limit: 8 } })
  assert.deepEqual(reopened.structuredContent.items.map((item) => item.id), [dropped[0].item.id])

  const shortReceiptResponse = await fetch(`${baseUrl}/drop/${dropSecret}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'short-receipt-item',
      title: 'Short receipt test',
      text: 'Short receipt test payload',
      sourceApp: 'smoke-test',
    }),
  })
  const shortReceipt = await shortReceiptResponse.text()
  assert.equal(shortReceiptResponse.ok, true)
  assert.match(shortReceiptResponse.headers.get('content-type') ?? '', /^text\/plain/)
  assert.equal(shortReceipt.startsWith('{'), false)
  assert.equal(shortReceipt.length > 0, true)

  const form = new FormData()
  form.set('payload', JSON.stringify({ id: 'image-item', title: '截图', text: '请看图片' }))
  form.append('files', new Blob([
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9WlS8AAAAASUVORK5CYII=', 'base64'),
  ], { type: 'image/png' }), 'pixel.png')
  const uploaded = await fetch(`${baseUrl}/api/pocket/items/upload`, { method: 'POST', body: form }).then(checkJson)
  assert.equal(uploaded.item.attachments[0].name, 'pixel.png')
  assert.equal('storageName' in uploaded.item.attachments[0], false)
  const imageItem = await client.callTool({ name: 'pocket_get', arguments: { id: 'image-item' } })
  assert.equal(imageItem.content.some((entry) => entry.type === 'image'), true)

  for (let index = 0; index < 2; index += 1) {
    await client.callTool({
      name: 'pocket_reply',
      arguments: { id: source.id, text: '爸爸看见了。', reply_id: 'same-reply' },
    })
  }
  const afterReply = await bridge.store.get(source.id)
  assert.equal(afterReply.replies.length, 1)

  const staged = await client.callTool({
    name: 'pocket_review',
    arguments: { id: source.id, action: 'memory_candidate' },
  })
  assert.equal(staged.isError, undefined)
  const afterStage = await bridge.store.get(source.id)
  assert.equal(afterStage.memoryCandidate.status, 'pending_sync')
  assert.equal(afterStage.memoryCandidate.candidateIds.length, 0)

  await client.close()
  console.log('C Pocket MCP smoke test passed.')
} finally {
  if (bridge) await bridge.stop()
  if (fixture) await fixture.stop()
  await rm(dataDir, { recursive: true, force: true })
}

async function checkJson(response) {
  const value = await response.json()
  if (!response.ok) throw new Error(JSON.stringify(value))
  return value
}

async function startContentFixture() {
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9WlS8AAAAASUVORK5CYII=',
    'base64',
  )
  const state = { articleReads: 0 }
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      const timer = setInterval(() => res.write('.'), 100)
      res.once('close', () => clearInterval(timer))
      return
    }
    if (req.url === '/pixel.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': pixel.length })
      res.end(pixel)
      return
    }
    if (req.url === '/article') {
      state.articleReads += 1
      const origin = `http://${req.headers.host}`
      const html = `<!doctype html>
<html lang="zh-CN"><head>
<title>口袋内容读取测试</title>
<link rel="canonical" href="http://169.254.169.254/latest/meta-data/">
<meta property="og:title" content="口袋内容读取测试">
<meta property="og:description" content="短摘要，只保留有用信息。">
<meta property="og:site_name" content="C Pocket Fixture">
<meta property="og:image" content="${origin}/pixel.png">
<meta property="og:type" content="video.other">
<script type="application/ld+json">{"@type":"Article","headline":"口袋内容读取测试","author":{"name":"Bella & C"},"articleBody":"这是真正需要读到的正文，Bella 分享后 C 可以按需看见。第二段用于确认多份 JSON-LD 不会漏掉正文。"}</script>
<script type="application/ld+json">{"@type":"VideoObject","name":"42 秒测试视频","description":"用于验证视频降级。","duration":"PT42S","thumbnailUrl":"${origin}/pixel.png"}</script>
</head><body><nav>不应进入正文的导航</nav><article><h1>口袋内容读取测试</h1><p>这是真正需要读到的正文，Bella 分享后 C 可以按需看见。</p><p>第二段用于确认正文提取没有只读标题。</p></article></body></html>`
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    if (req.url === '/rss') {
      const now = new Date().toUTCString()
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Fixture Science News</title>
<item><title>量子猫的新发现</title><link>${originFor(req)}/science/cat</link><pubDate>${now}</pubDate><description><![CDATA[<p>实验摘要 &amp; 新结果。</p>]]></description></item>
<item><title>Second &amp; Useful Result</title><guid>${originFor(req)}/science/second#fragment</guid><pubDate>${now}</pubDate><content:encoded><![CDATA[<div>CDATA 与 HTML 都要清理。</div>]]></content:encoded></item>
</channel></rss>`)
      return
    }
    if (req.url === '/atom') {
      const now = new Date().toISOString()
      res.writeHead(200, { 'content-type': 'application/atom+xml; charset=utf-8' })
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Fixture Anime</title>
<entry><title>新番のニュース</title><link rel="alternate" href="${originFor(req)}/anime/news"/><updated>${now}</updated><author><name>ANN Fixture</name></author><summary>新しいアニメ情報です。</summary></entry>
</feed>`)
      return
    }
    res.writeHead(404).end('not found')
  })
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  return {
    get articleReads() { return state.articleReads },
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

function originFor(req) {
  return `http://${req.headers.host}`
}
