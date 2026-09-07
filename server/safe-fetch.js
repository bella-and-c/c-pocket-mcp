import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export class SafeFetchError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'SafeFetchError'
    this.code = code
    Object.assign(this, details)
  }
}

/**
 * Fetch an HTTP(S) resource without allowing DNS rebinding, private-network
 * access, unbounded redirects, or unbounded response bodies.
 *
 * The returned body is transparently decompressed and limited by maxBytes.
 */
export async function fetchSafeResource(input, options = {}) {
  const method = String(options.method || 'GET').toUpperCase()
  const timeoutMs = clampInteger(options.timeoutMs, 250, 120_000, DEFAULT_TIMEOUT_MS)
  const maxBytes = clampInteger(options.maxBytes, 0, 256 * 1024 * 1024, DEFAULT_MAX_BYTES)
  const maxRedirects = clampInteger(options.maxRedirects, 0, 10, DEFAULT_MAX_REDIRECTS)
  const deadline = Date.now() + timeoutMs
  let currentUrl = parseHttpUrl(input)
  const redirects = []

  for (let redirectCount = 0; ; redirectCount += 1) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new SafeFetchError('TIMEOUT', 'The remote content request timed out.', { url: currentUrl.href })
    }

    const pinnedAddress = await resolveSafeAddress(currentUrl, {
      allowPrivateHosts: options.allowPrivateHosts === true,
      timeoutMs: remainingMs,
    })
    const requestTimeMs = deadline - Date.now()
    if (requestTimeMs <= 0) {
      throw new SafeFetchError('TIMEOUT', 'The remote content request timed out.', { url: currentUrl.href })
    }
    const response = await requestOnce(currentUrl, pinnedAddress, {
      method,
      headers: options.headers,
      maxBytes,
      timeoutMs: requestTimeMs,
      signal: options.signal,
    })

    const location = response.headers.location
    if (REDIRECT_STATUSES.has(response.status) && location) {
      if (redirectCount >= maxRedirects) {
        throw new SafeFetchError('TOO_MANY_REDIRECTS', 'The remote content redirected too many times.', {
          status: response.status,
          url: currentUrl.href,
        })
      }
      let nextUrl
      try {
        nextUrl = new URL(location, currentUrl)
      } catch {
        throw new SafeFetchError('INVALID_REDIRECT', 'The remote content returned an invalid redirect.', {
          status: response.status,
          url: currentUrl.href,
        })
      }
      redirects.push({ from: currentUrl.href, to: nextUrl.href, status: response.status })
      currentUrl = parseHttpUrl(nextUrl)
      continue
    }

    return {
      ...response,
      url: currentUrl.href,
      redirects,
      contentType: parseContentType(response.headers['content-type']),
    }
  }
}

export async function assertSafeHttpUrl(input, { allowPrivateHosts = false } = {}) {
  const url = parseHttpUrl(input)
  await resolveSafeAddress(url, { allowPrivateHosts, timeoutMs: DEFAULT_TIMEOUT_MS })
  return url
}

export function isPrivateAddress(address) {
  const family = net.isIP(address)
  if (family === 4) return isBlockedIpv4(address)
  if (family === 6) return isBlockedIpv6(address)
  return true
}

async function resolveSafeAddress(url, { allowPrivateHosts, timeoutMs }) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  let addresses
  const literalFamily = net.isIP(hostname)
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }]
  } else {
    try {
      addresses = await withTimeout(
        dns.lookup(hostname, { all: true, verbatim: true }),
        timeoutMs,
        () => new SafeFetchError('TIMEOUT', 'The remote hostname lookup timed out.', { url: url.href }),
      )
    } catch (error) {
      throw new SafeFetchError('DNS_FAILED', 'The remote hostname could not be resolved.', {
        url: url.href,
        cause: error,
      })
    }
  }

  if (!addresses.length) {
    throw new SafeFetchError('DNS_EMPTY', 'The remote hostname did not resolve to an address.', { url: url.href })
  }
  if (!allowPrivateHosts && addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new SafeFetchError('PRIVATE_ADDRESS', 'Private, loopback, and reserved network addresses are blocked.', {
      url: url.href,
    })
  }
  return addresses[0]
}

function withTimeout(promise, timeoutMs, createError) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(createError()), Math.max(1, timeoutMs))
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function requestOnce(url, pinnedAddress, options) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    let settled = false
    let deadlineTimer
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(deadlineTimer)
      callback(value)
    }
    const lookup = (_hostname, lookupOptions, callback) => {
      if (lookupOptions?.all) {
        callback(null, [{ address: pinnedAddress.address, family: pinnedAddress.family }])
      } else {
        callback(null, pinnedAddress.address, pinnedAddress.family)
      }
    }
    const request = transport.request(url, {
      method: options.method,
      lookup,
      headers: buildHeaders(options.headers),
    }, async (response) => {
      try {
        const headers = normalizeHeaders(response.headers)
        const redirect = REDIRECT_STATUSES.has(response.statusCode || 0) && headers.location
        const noBody = options.method === 'HEAD' || response.statusCode === 204 || response.statusCode === 304
        if (redirect || noBody) {
          response.resume()
          finish(resolve, {
            status: response.statusCode || 0,
            statusText: response.statusMessage || '',
            headers,
            body: Buffer.alloc(0),
          })
          return
        }
        const body = await readLimitedBody(response, headers['content-encoding'], options.maxBytes)
        finish(resolve, {
          status: response.statusCode || 0,
          statusText: response.statusMessage || '',
          headers,
          body,
        })
      } catch (error) {
        request.destroy()
        finish(reject, enrichResponseError(error, response, url))
      }
    })

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new SafeFetchError('TIMEOUT', 'The remote content request timed out.', { url: url.href }))
    })
    deadlineTimer = setTimeout(() => {
      request.destroy(new SafeFetchError('TIMEOUT', 'The remote content request timed out.', { url: url.href }))
    }, options.timeoutMs)
    request.on('error', (error) => {
      const safeError = error instanceof SafeFetchError
        ? error
        : new SafeFetchError('REQUEST_FAILED', 'The remote content request failed.', { url: url.href, cause: error })
      finish(reject, safeError)
    })

    if (options.signal) {
      const abort = () => request.destroy(new SafeFetchError('ABORTED', 'The remote content request was cancelled.', {
        url: url.href,
      }))
      if (options.signal.aborted) abort()
      else options.signal.addEventListener('abort', abort, { once: true })
      request.once('close', () => options.signal?.removeEventListener('abort', abort))
    }
    request.end()
  })
}

async function readLimitedBody(response, contentEncoding, maxBytes) {
  let stream = response
  const encoding = String(contentEncoding || '').split(',')[0].trim().toLowerCase()
  if (encoding === 'gzip' || encoding === 'x-gzip') stream = response.pipe(createGunzip())
  else if (encoding === 'deflate') stream = response.pipe(createInflate())
  else if (encoding === 'br') stream = response.pipe(createBrotliDecompress())

  const chunks = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.length
    if (total > maxBytes) {
      stream.destroy()
      response.destroy()
      throw new SafeFetchError('BODY_TOO_LARGE', `The remote content exceeded the ${maxBytes}-byte limit.`, {
        maxBytes,
      })
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

function parseHttpUrl(input) {
  let url
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(String(input))
  } catch {
    throw new SafeFetchError('INVALID_URL', 'A valid HTTP(S) URL is required.')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new SafeFetchError('INVALID_PROTOCOL', 'Only HTTP and HTTPS URLs can be read.', { url: url.href })
  }
  if (url.username || url.password) {
    throw new SafeFetchError('URL_CREDENTIALS', 'URLs containing credentials are not allowed.', { url: url.href })
  }
  return url
}

function buildHeaders(extraHeaders) {
  const headers = {
    accept: 'text/html,application/xhtml+xml,image/avif,image/webp,image/png,image/jpeg,video/*;q=0.8,*/*;q=0.5',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
    connection: 'close',
    'user-agent': 'C-Pocket-Content-Reader/2.6 (+https://github.com/bella-and-c/c-pocket-mcp)',
    ...(extraHeaders || {}),
  }
  for (const key of Object.keys(headers)) {
    if (['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'proxy-authorization'].includes(key.toLowerCase())) {
      delete headers[key]
    }
  }
  headers.connection = 'close'
  return headers
}

function normalizeHeaders(headers) {
  const normalized = {}
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) normalized[key.toLowerCase()] = value.join(', ')
    else if (value !== undefined) normalized[key.toLowerCase()] = String(value)
  }
  return normalized
}

function parseContentType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase()
}

function enrichResponseError(error, response, url) {
  if (!(error instanceof SafeFetchError)) return error
  error.status = response.statusCode || 0
  error.url = error.url || url.href
  error.contentType = parseContentType(response.headers['content-type'])
  return error
}

function isBlockedIpv4(address) {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true
  const [a, b, c] = octets
  return a === 0
    || a === 10
    || a === 100 && b >= 64 && b <= 127
    || a === 127
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 0 && c === 0
    || a === 192 && b === 0 && c === 2
    || a === 192 && b === 168
    || a === 198 && (b === 18 || b === 19)
    || a === 198 && b === 51 && c === 100
    || a === 203 && b === 0 && c === 113
    || a >= 224
}

function isBlockedIpv6(address) {
  const normalized = address.toLowerCase().split('%')[0]
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isBlockedIpv4(mapped[1])

  const bytes = ipv6ToBytes(normalized)
  if (!bytes) return true
  const allZero = bytes.every((value) => value === 0)
  const loopback = bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1
  const mappedV4 = bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  const compatibleV4 = bytes.slice(0, 12).every((value) => value === 0)
  const translatedV4 = bytes.slice(0, 8).every((value) => value === 0)
    && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0
  const wellKnownNat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b
    && bytes.slice(4, 12).every((value) => value === 0)
  const localNat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b
    && bytes[4] === 0 && bytes[5] === 1
  const sixToFour = bytes[0] === 0x20 && bytes[1] === 0x02
  if (allZero || loopback) return true
  if (mappedV4 || compatibleV4 || translatedV4 || wellKnownNat64 || localNat64) {
    return isBlockedIpv4(bytes.slice(12).join('.'))
  }
  if (sixToFour) return isBlockedIpv4(bytes.slice(2, 6).join('.'))
  return bytes[0] === 0xfc || bytes[0] === 0xfd
    || bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80
    || bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0
    || bytes[0] === 0xff
    || bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8
}

function ipv6ToBytes(address) {
  const halves = address.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null
  const groups = [...left, ...Array(missing).fill('0'), ...right]
  if (groups.length !== 8) return null
  const bytes = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    const value = Number.parseInt(group, 16)
    bytes.push(value >> 8, value & 0xff)
  }
  return bytes
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)))
}
