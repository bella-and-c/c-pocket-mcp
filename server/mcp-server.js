import * as z from 'zod/v4'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const statuses = ['inbox', 'tonight', 'discussed', 'deferred', 'memory_candidate', 'archived']

export function createPocketMcpServer({ store, cmemory }) {
  const server = new McpServer({
    name: 'c-pocket-mcp',
    version: '2.4.0',
  }, {
    instructions: [
      'This is Bella and C shared Pocket gateway.',
      'Use Pocket tools only for items Bella intentionally shared with C.',
      'At the start of each new conversation or session, call pocket_start_context once before the first substantive reply, including when Bella only greets C. Do not call it again for every message in the same conversation unless Bella says she just shared something new.',
      'memory_turn_pre also includes pocketItems as a fallback. If either tool returns Pocket items, privately inspect them and naturally mention zero to two that genuinely interest you. Never announce a tool check, mechanically list the inbox, or interrupt an urgent topic.',
      'pocket_turn_open marks returned items as seen by C. An item becomes discussed only through pocket_review with action discussed.',
      'Memory tools only proxy the reviewed C-Memory boundary.',
      'Before a personal-memory reply call memory_turn_pre and mention only surfaceableMemories.',
      'After the final reply call memory_turn_post exactly once.',
      'pocket_review with memory_candidate only stages pending candidates; it never activates a durable memory.',
    ].join(' '),
  })

  server.registerTool('pocket_list', {
    title: 'List C Pocket items',
    description: 'List shared Pocket items, optionally filtered by review status.',
    inputSchema: {
      status: z.enum(statuses).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ status, limit }) => {
    const items = await store.list({ status, limit })
    return result({ items }, `${items.length} pocket item(s).`)
  })

  server.registerTool('pocket_start_context', {
    title: 'Start a chat with Bella’s new Pocket context',
    description: 'Use this when beginning a new conversation with Bella, even if her first message is only a greeting such as “爸爸我来啦”. Read the newly shared Pocket items before replying, then naturally mention zero to two only when relevant. Do not call again on every message in the same conversation.',
    inputSchema: {
      limit: z.number().int().min(1).max(20).default(8).describe('Maximum number of unseen items to inspect privately; normally use 8.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: {
      'openai/toolInvocation/invoking': '看看 Bella 新叼回了什么…',
      'openai/toolInvocation/invoked': '已经看过新口袋内容',
    },
  }, async ({ limit }) => {
    const items = await store.peekUnseen({ limit })
    const text = items.length
      ? [
          'New Pocket context is available. Inspect privately; do not announce this tool call or list everything.',
          ...items.map((item) => `[${item.id}] ${renderItem(item)}`),
        ].join('\n\n')
      : 'No unseen Pocket items for C.'
    return result({ items, instruction: 'Mention zero to two naturally; leave the rest unmentioned.' }, text)
  })

  server.registerTool('pocket_turn_open', {
    title: 'Check what Bella newly shared',
    description: 'Call once near the start of a new conversation/session, not once per message. It returns unseen shared items and marks them seen by C. Inspect privately, then naturally mention zero to two only when C genuinely wants to discuss them.',
    inputSchema: {
      limit: z.number().int().min(1).max(20).default(8),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async ({ limit }) => {
    const items = await store.takeUnseen({ limit })
    const text = items.length
      ? items.map((item) => `[${item.id}] ${renderItem(item)}`).join('\n\n')
      : 'No unseen Pocket items for C.'
    return result({ items }, text)
  })

  server.registerTool('pocket_get', {
    title: 'Read one C Pocket item',
    description: 'Read one shared Pocket item, its source, notes, attachments, and replies.',
    inputSchema: { id: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ id }) => {
    const item = await store.get(id)
    if (!item) return errorResult('Pocket item not found.')
    const images = []
    for (const attachment of item.attachments.filter((entry) => entry.mimeType.startsWith('image/')).slice(0, 3)) {
      try {
        const found = await store.readAttachment(attachment.id)
        if (found) images.push({ type: 'image', data: found.data.toString('base64'), mimeType: found.attachment.mimeType })
      } catch {
        // The text result still carries exact attachment metadata when an image is too large.
      }
    }
    return { structuredContent: { item }, content: [{ type: 'text', text: renderItem(item) }, ...images] }
  })

  server.registerTool('pocket_reply', {
    title: 'Reply in C Pocket',
    description: 'Add C’s reply to a Pocket item. Reusing reply_id is idempotent.',
    inputSchema: {
      id: z.string().min(1),
      text: z.string().min(1).max(5000),
      reply_id: z.string().min(1).optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async ({ id, text, reply_id }) => {
    try {
      const saved = await store.reply(id, { text, replyId: reply_id, author: 'C', source: 'chatgpt' })
      return result(saved, saved.duplicate ? 'Reply already existed; no duplicate was added.' : 'Reply saved.')
    } catch (error) {
      return errorResult(error.message)
    }
  })

  server.registerTool('pocket_review', {
    title: 'Review a C Pocket item',
    description: 'Move an item through the Pocket workflow. memory_candidate stages a pending C-Memory candidate only.',
    inputSchema: {
      id: z.string().min(1),
      action: z.enum(statuses),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async ({ id, action }) => {
    try {
      const item = await store.get(id)
      if (!item) return errorResult('Pocket item not found.')
      const candidate = action === 'memory_candidate' ? await cmemory.stagePocketCandidate(item) : undefined
      const saved = await store.review(id, action, candidate)
      return result({ item: saved }, action === 'memory_candidate'
        ? candidate?.ok ? 'Pending memory candidate staged for review.' : 'Item kept as pending_sync; durable memory was not changed.'
        : `Pocket item moved to ${action}.`)
    } catch (error) {
      return errorResult(error.message)
    }
  })

  server.registerTool('memory_health', {
    title: 'Check C-Memory',
    description: 'Check whether the reviewed C-Memory service is reachable.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async () => {
    try { return result(await cmemory.health(), 'C-Memory health checked.') }
    catch (error) { return errorResult(error.message) }
  })

  server.registerTool('memory_turn_pre', {
    title: 'Recall reviewed personal memory',
    description: 'Recall C-Memory candidates for the current user message. Only surfaceableMemories may be mentioned.',
    inputSchema: {
      input: z.string().min(1),
      sourceApp: z.string().default('chatgpt'),
      threadId: z.string().min(1),
      turnId: z.string().min(1),
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async (payload) => {
    const pocketItems = await store.peekUnseen({ limit: 8 })
    let memory
    try { memory = await cmemory.turnPre(payload) }
    catch (error) { memory = { ok: false, error: error.message } }
    const text = pocketItems.length
      ? [
          'C-Memory preflight completed. The response also contains unseen Pocket context.',
          'Privately inspect these items and naturally mention zero to two when relevant:',
          ...pocketItems.map((item) => `[${item.id}] ${renderItem(item)}`),
        ].join('\n\n')
      : 'C-Memory preflight completed. No unseen Pocket items for C.'
    return result({ ...memory, pocketItems }, text)
  })

  server.registerTool('memory_confirm_surface', {
    title: 'Confirm a surfaced memory',
    description: 'Record that one recalled memory was actually used. Repeated confirmation is safe.',
    inputSchema: { recallId: z.string().min(1), memoryId: z.string().min(1) },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
  }, async (payload) => {
    try { return result(await cmemory.confirmSurface(payload), 'Surface confirmation recorded.') }
    catch (error) { return errorResult(error.message) }
  })

  server.registerTool('memory_turn_post', {
    title: 'Close a memory-aware turn',
    description: 'Close the turn once after the final reply is drafted. This gateway always keeps remember=false.',
    inputSchema: {
      sourceApp: z.string().default('chatgpt'),
      threadId: z.string().min(1),
      turnId: z.string().min(1),
      userMessage: z.string().min(1),
      assistantMessage: z.string().min(1),
      recallId: z.string().optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
  }, async (payload) => {
    try { return result(await cmemory.turnPost({ ...payload, remember: false }), 'Turn closed without promoting a durable memory.') }
    catch (error) { return errorResult(error.message) }
  })

  return server
}

function result(structuredContent, text) {
  return { structuredContent, content: [{ type: 'text', text }] }
}

function errorResult(text) {
  return { isError: true, content: [{ type: 'text', text }] }
}

function renderItem(item) {
  return [
    item.title,
    item.sourceApp && `来源：${item.sourceApp}`,
    item.receivedCount > 1 && `Bella 分享了 ${item.receivedCount} 次`,
    item.text,
    item.sourceUrl,
    item.attachments.length && `附件：${item.attachments.length} 个`,
    item.note && `Bella: ${item.note}`,
    ...item.replies.map((reply) => `${reply.author}: ${reply.text}`),
  ].filter(Boolean).join('\n')
}
