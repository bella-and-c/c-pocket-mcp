import { fileURLToPath } from 'node:url'
import path from 'node:path'
import express from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { PocketStore, httpError } from './store.js'
import { CMemoryClient } from './cmemory-client.js'
import { createPocketMcpServer } from './mcp-server.js'
import { normalizeIncomingShare } from './share-normalizer.js'

const SERVICE_VERSION = '2.4.0'

export async function createBridgeApp(config = {}) {
  const root = path.dirname(fileURLToPath(import.meta.url))
  const settings = {
    dataDir: config.dataDir ?? process.env.C_POCKET_DATA_DIR ?? path.join(root, '..', 'data'),
    bridgeToken: config.bridgeToken ?? cleanEnvironmentValue(process.env.C_POCKET_BRIDGE_TOKEN),
    allowedOrigins: config.allowedOrigins ?? splitOrigins(process.env.C_POCKET_ALLOWED_ORIGINS),
    cmemoryBaseUrl: config.cmemoryBaseUrl ?? process.env.CMEMORY_BASE_URL ?? 'http://127.0.0.1:4282',
    cmemoryToken: config.cmemoryToken ?? process.env.CMEMORY_TOKEN ?? '',
    serverHost: config.host ?? (cleanEnvironmentValue(process.env.HOST) || '127.0.0.1'),
    mcpPath: normalizeMcpPath(config.mcpPath ?? (cleanEnvironmentValue(process.env.C_POCKET_MCP_PATH) || '/mcp')),
    temporaryPublicMcp: config.temporaryPublicMcp ?? process.argv.includes('--temporary-public-mcp'),
    dropSecret: config.dropSecret ?? (cleanEnvironmentValue(process.env.C_POCKET_DROP_SECRET) || `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`),
  }
  const store = new PocketStore(settings.dataDir)
  await store.init()
  const cmemory = new CMemoryClient({ baseUrl: settings.cmemoryBaseUrl, token: settings.cmemoryToken })
  const upload = multer({
    storage: multer.diskStorage({
      destination: store.mediaDir,
      filename: (_req, _file, callback) => callback(null, randomUUID()),
    }),
    limits: { files: 5, fileSize: 25 * 1024 * 1024 },
  })
  const app = createMcpExpressApp({ host: settings.temporaryPublicMcp ? '0.0.0.0' : settings.serverHost })
  const transports = new Map()

  app.disable('x-powered-by')
  app.use(express.json({ limit: '2mb' }))
  app.use(express.urlencoded({ extended: false, limit: '2mb' }))
  app.use(express.text({ type: ['text/plain', 'text/*'], limit: '2mb' }))
  app.use((req, res, next) => {
    const origin = req.get('origin')
    if (origin && settings.allowedOrigins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'Origin')
      res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-session-id')
      res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

  app.get('/health', async (_req, res) => {
    const items = await store.list({ limit: 1 })
    res.json({ ok: true, service: 'c-pocket-mcp', version: SERVICE_VERSION, storeReady: Array.isArray(items) })
  })

  app.get('/local/config', (req, res) => {
    if (!isLoopbackRequest(req)) return res.status(404).end()
    res.json({ mcpPath: settings.mcpPath, dropPath: `/drop/${settings.dropSecret}` })
  })

  app.use('/api', (req, res, next) => {
    if (isAuthorized(req, settings.bridgeToken)) return next()
    res.status(settings.bridgeToken ? 401 : 503).json({
      error: settings.bridgeToken ? 'Unauthorized.' : 'C_POCKET_BRIDGE_TOKEN is required for non-loopback access.',
    })
  })
  app.use(settings.mcpPath, (req, res, next) => {
    // A non-default path is a high-entropy capability URL for temporary developer-mode testing.
    if (settings.temporaryPublicMcp || settings.mcpPath !== '/mcp' || isAuthorized(req, settings.bridgeToken)) return next()
    res.status(settings.bridgeToken ? 401 : 503).json({
      error: settings.bridgeToken ? 'Unauthorized.' : 'C_POCKET_BRIDGE_TOKEN is required for non-loopback access.',
    })
  })

  app.get('/api/pocket/items', async (req, res, next) => {
    try {
      res.json({ items: await store.list({ status: req.query.status, limit: req.query.limit }) })
    } catch (error) { next(error) }
  })

  app.get('/api/pocket/items/:id', async (req, res, next) => {
    try {
      const item = await store.get(req.params.id)
      if (!item) return res.status(404).json({ error: 'Pocket item not found.' })
      res.json({ item })
    } catch (error) { next(error) }
  })

  app.post('/api/pocket/items', async (req, res, next) => {
    try {
      const item = await store.upsert(req.body)
      res.status(200).json({ item })
    } catch (error) { next(error) }
  })

  const handleUpload = ({ defaultText = false } = {}) => async (req, res, next) => {
    try {
      let payload = parseRequestPayload(req.body)
      if (typeof req.body?.payload === 'string' && req.body.payload.trim()) payload = JSON.parse(req.body.payload)
      delete payload.payload
      payload = normalizeIncomingShare(payload)
      if (isSelfServiceShare(payload.sourceUrl, req, settings)) {
        throw httpError(400, '这看起来是口袋自己的服务地址，没有作为收藏保存。请从原 App 的分享菜单运行快捷指令。')
      }
      const files = Array.isArray(req.files) ? req.files : []
      const attachments = files.map((file) => ({
        id: randomUUID(),
        name: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        storageName: file.filename,
      }))
      const item = await store.upsert({ ...payload, attachments: [...(payload.attachments ?? []), ...attachments] })
      const receipt = createDropReceipt(item)
      const responseMode = String(req.query.response ?? '').toLowerCase()
      if (responseMode === 'text' || (defaultText && responseMode !== 'json')) {
        return res.status(200).type('text/plain; charset=utf-8').send(receipt.message)
      }
      res.status(200).json({ ok: true, message: receipt.message, receipt, item })
    } catch (error) { next(error) }
  }

  app.post('/api/pocket/items/upload', upload.array('files', 5), handleUpload())
  app.post(`/drop/${settings.dropSecret}`, upload.array('files', 5), handleUpload({ defaultText: true }))

  app.get('/api/pocket/media/:attachmentId', async (req, res, next) => {
    try {
      const found = await store.readAttachment(req.params.attachmentId, 25 * 1024 * 1024)
      if (!found) return res.status(404).json({ error: 'Attachment not found.' })
      res.type(found.attachment.mimeType)
      res.setHeader('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(found.attachment.name)}`)
      res.send(found.data)
    } catch (error) { next(error) }
  })

  app.post('/api/pocket/items/:id/replies', async (req, res, next) => {
    try {
      res.json(await store.reply(req.params.id, req.body))
    } catch (error) { next(error) }
  })

  app.post('/api/pocket/items/:id/review', async (req, res, next) => {
    try {
      const item = await store.get(req.params.id)
      if (!item) return res.status(404).json({ error: 'Pocket item not found.' })
      const candidate = req.body.action === 'memory_candidate'
        ? await cmemory.stagePocketCandidate(item)
        : undefined
      res.json({ item: await store.review(req.params.id, req.body.action, candidate) })
    } catch (error) { next(error) }
  })

  const handleMcpPost = async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id']
      let transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) {
        if (sessionId || !isInitializeRequest(req.body)) {
          return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid MCP session.' }, id: null })
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => transports.set(id, transport),
        })
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId)
        }
        const server = createPocketMcpServer({ store, cmemory })
        await server.connect(transport)
      }
      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: error.message }, id: null })
    }
  }

  app.post(settings.mcpPath, handleMcpPost)
  app.get(settings.mcpPath, async (req, res) => {
    const transport = transports.get(req.headers['mcp-session-id'])
    if (!transport) return res.status(400).send('Invalid or missing MCP session.')
    await transport.handleRequest(req, res)
  })
  app.delete(settings.mcpPath, async (req, res) => {
    const transport = transports.get(req.headers['mcp-session-id'])
    if (!transport) return res.status(400).send('Invalid or missing MCP session.')
    await transport.handleRequest(req, res)
  })

  app.use((error, _req, res, _next) => {
    void _next
    res.status(Number(error?.status) || 500).json({ error: error?.message || 'Internal server error.' })
  })

  return {
    app,
    store,
    cmemory,
    async close() {
      await Promise.allSettled([...transports.values()].map((transport) => transport.close()))
      transports.clear()
    },
  }
}

export async function startBridge(config = {}) {
  const bridge = await createBridgeApp(config)
  const port = Number(config.port ?? process.env.PORT ?? 8787)
  const host = config.host ?? process.env.HOST ?? '127.0.0.1'
  const httpServer = await new Promise((resolve, reject) => {
    const server = bridge.app.listen(port, host, () => resolve(server))
    server.once('error', reject)
  })
  return {
    ...bridge,
    httpServer,
    address: httpServer.address(),
    mcpPath: config.mcpPath ?? (cleanEnvironmentValue(process.env.C_POCKET_MCP_PATH) || '/mcp'),
    async stop() {
      await bridge.close()
      await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()))
    },
  }
}

function isAuthorized(req, token) {
  if (!token) return isLoopbackRequest(req)
  return req.get('authorization') === `Bearer ${token}`
}

function isLoopbackRequest(req) {
  const remote = req.socket.remoteAddress ?? ''
  const forwarded = req.get('cf-connecting-ip') || req.get('x-forwarded-for')?.split(',')[0]?.trim()
  return !forwarded && (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')
}

function splitOrigins(value = '') {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean)
}

function cleanEnvironmentValue(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim()
}

function normalizeMcpPath(value) {
  const candidate = `/${String(value).replace(/^\/+|\/+$/g, '')}`
  if (!/^\/mcp(?:\/[A-Za-z0-9_-]{20,})?$/.test(candidate)) {
    throw new Error('C_POCKET_MCP_PATH must be /mcp or /mcp/<20+ character secret>.')
  }
  return candidate
}

function parseRequestPayload(body) {
  if (typeof body === 'string') {
    const value = body.trim()
    if (!value) return {}
    if (value.startsWith('{') || value.startsWith('[')) {
      try { return JSON.parse(value) } catch { /* Treat malformed JSON-looking text as an ordinary share. */ }
    }
    return { share: value }
  }
  if (Array.isArray(body)) return { share: body }
  return body && typeof body === 'object' ? { ...body } : {}
}

function createDropReceipt(item) {
  const merged = Number(item.receivedCount) > 1
  const title = item.title || item.sourceApp || '刚刚分享的东西'
  return {
    status: merged ? 'merged' : 'saved',
    itemId: item.id,
    title,
    sourceApp: item.sourceApp,
    receivedCount: item.receivedCount,
    message: merged
      ? `爸爸又收到一次，已经合并好了：${title}`
      : `爸爸收到了：${title}`,
  }
}

function isSelfServiceShare(value, req, settings) {
  try {
    const url = new URL(value)
    const requestHost = String(req.get('host') || '').toLowerCase()
    if (!requestHost || url.host.toLowerCase() !== requestHost) return false
    return url.pathname === settings.mcpPath
      || url.pathname === '/health'
      || url.pathname.startsWith('/api/')
      || url.pathname.startsWith('/drop/')
  } catch {
    return false
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const bridge = await startBridge()
  const address = bridge.address
  console.log(`C Pocket MCP listening on http://${address.address}:${address.port} (private MCP path configured)`)
  const shutdown = async () => {
    await bridge.stop()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
