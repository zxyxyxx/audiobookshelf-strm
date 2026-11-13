const axios = require('axios')
const http = require('http')
const https = require('https')
const Path = require('path')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')
const { filePathToPOSIX } = require('./fileUtils')

const STRM_COMMENT_PREFIXES = ['#', '//']
const DEFAULT_PROBE_SKIP_PREFIXES = ['/CloudNAS']

// --- HTTP agents -------------------------------------------------------------
// Keep-alive matters for first-byte latency: every cold play used to pay a fresh
// TCP + TLS handshake to OpenList and to the CDN, which is 100-500 ms over WAN
// (more with cold DNS). Sharing one agent per protocol removes that cost from
// the warm path, the refresh path and the streaming path.
const HTTP_MAX_SOCKETS = Number(process.env.STRM_HTTP_MAX_SOCKETS) || 64
const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: HTTP_MAX_SOCKETS })
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: HTTP_MAX_SOCKETS })
const AGENT_CONFIG = { httpAgent, httpsAgent }

// --- Upstream tuning ---------------------------------------------------------
// A cross-border deployment (overseas ARM server reaching a domestic cloud
// drive) needs longer timeouts than a LAN NAS: 15s is often not enough for a
// cold Quark/115 API call from another continent.
const UPSTREAM_TIMEOUTS = {
  stream: Number(process.env.STRM_STREAM_TIMEOUT_MS) || 15000,
  probe: Number(process.env.STRM_PROBE_TIMEOUT_MS) || 10000,
  warm: Number(process.env.STRM_WARM_TIMEOUT_MS) || 30000
}
// Extra attempts for transient upstream failures (5xx / connection resets).
const STREAM_RETRY_COUNT = Number(process.env.STRM_STREAM_RETRY ?? 1)
// Only retry when the first attempt failed fast: retrying after a 15s timeout
// just doubles the time before the user sees an error.
const RETRY_FAST_FAIL_MS = Number(process.env.STRM_RETRY_FAST_FAIL_MS) || 5000

/**
 * Optional egress proxy for upstream requests.
 *   STRM_UPSTREAM_PROXY=http://user:pass@proxy:7890
 *   STRM_UPSTREAM_PROXY=direct   → ignore HTTP_PROXY/HTTPS_PROXY from the environment
 * Unset → axios keeps its default behaviour (honours HTTP_PROXY/HTTPS_PROXY/NO_PROXY).
 */
const UPSTREAM_PROXY_CONFIG = (() => {
  const raw = (process.env.STRM_UPSTREAM_PROXY || '').trim()
  if (!raw) return {}
  if (['direct', 'off', 'none', 'false'].includes(raw.toLowerCase())) return { proxy: false }
  try {
    const parsed = new URL(raw)
    const config = {
      proxy: {
        protocol: parsed.protocol.replace(':', ''),
        host: parsed.hostname,
        port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
      }
    }
    if (parsed.username) {
      config.proxy.auth = { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) }
    }
    return config
  } catch (error) {
    Logger.warn(`[STRM-PLAY] Ignoring invalid STRM_UPSTREAM_PROXY: ${raw}`)
    return {}
  }
})()

// --- Remote signed-URL cache -------------------------------------------------
// Bounded LRU: a large library can reference thousands of STRM targets and the
// cache used to grow without limit. Entries are evicted oldest-first once the
// configured cap is exceeded.
const REMOTE_URL_CACHE_MAX = Number(process.env.STRM_URL_CACHE_MAX) || 500
const remoteUrlCache = new Map()

// Refresh a cached signed URL this long before it expires, in the background, so
// the next play never pays the resolution cost.
const REFRESH_AHEAD_MS = Number(process.env.STRM_URL_REFRESH_AHEAD_MS ?? 60_000)
const refreshTimers = new Map()

// URLs currently being pre-warmed (dedupes concurrent warms).
const warmingUrls = new Set()

// Cancellation handles for in-flight warms, so a real playback request can kill
// a speculative warm that is competing for the same upstream connection.
// (axios 0.27 has no AbortSignal support, so CancelToken is used.)
const warmInflight = new Map()

// Per-URL serialization of cold upstream resolutions (STRM -> OpenList -> CDN).
// Without this, N clients hitting a cold track at the same time each run the
// whole redirect chain, which is what makes OpenList/Quark rate-limit us.
const coldResolveTails = new Map()

// Global limiter for background pre-warms so multi-user playback cannot flood
// the cloud API with speculative requests.
const warmLimiter = createConcurrencyLimiter(Number(process.env.STRM_PRELOAD_CONCURRENCY) || 2)

/**
 * Minimal promise concurrency limiter.
 *
 * @param {number} limit
 * @returns {(fn: () => Promise<any>) => Promise<any>}
 */
function createConcurrencyLimiter(limit) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1
  let active = 0
  /** @type {{fn: Function, resolve: Function, reject: Function}[]} */
  const queue = []

  const runNext = () => {
    if (active >= max || !queue.length) return
    active++
    const { fn, resolve, reject } = queue.shift()
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--
        runNext()
      })
  }

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject })
      runNext()
    })
  }
}

/**
 * Run `fn` exclusively for the given key, queuing concurrent callers.
 * Callers that arrive while a resolution is in flight wait for it, then re-read
 * the cache inside `fn` (see `resolveRemote`) so only one upstream call is made.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function runExclusive(key, fn) {
  const previous = coldResolveTails.get(key) || Promise.resolve()
  let release
  const current = new Promise((resolve) => (release = resolve))
  const tail = previous.then(() => current)
  coldResolveTails.set(key, tail)

  return previous
    .catch(() => {})
    .then(() => fn())
    .finally(() => {
      release()
      if (coldResolveTails.get(key) === tail) coldResolveTails.delete(key)
    })
}

function getCachedRemoteUrl(remoteUrl) {
  loadPersistedCache()
  const cached = remoteUrlCache.get(remoteUrl)
  if (!cached || cached.expiresAt <= Date.now()) {
    remoteUrlCache.delete(remoteUrl)
    return null
  }
  // Touch: move to the tail so the LRU keeps hot entries.
  remoteUrlCache.delete(remoteUrl)
  remoteUrlCache.set(remoteUrl, cached)
  return cached.url
}

// --- Optional on-disk cache ---------------------------------------------------
// After a container restart (Watchtower image updates restart ABS regularly)
// every signed URL is cold again. Persisting the cache removes that cold start.
// Off by default: the file holds signed URLs, so treat it as a secret.
const PERSIST_URL_CACHE = process.env.STRM_PERSIST_URL_CACHE === '1'
const PERSIST_DEBOUNCE_MS = 5000
let persistLoaded = false
let persistWriteTimer = null

function getPersistPath() {
  const metadataPath = global.MetadataPath
  if (!metadataPath) return null
  return Path.join(metadataPath, 'strm-url-cache.json')
}

/**
 * Restore the signed-URL cache from disk (once per process, opt-in).
 */
function loadPersistedCache() {
  if (!PERSIST_URL_CACHE || persistLoaded) return
  persistLoaded = true
  const filePath = getPersistPath()
  if (!filePath) return
  try {
    if (!fs.existsSync(filePath)) return
    const entries = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!Array.isArray(entries)) return
    const now = Date.now()
    let restored = 0
    for (const entry of entries) {
      if (!entry?.key || !entry?.url || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) continue
      remoteUrlCache.set(entry.key, { url: entry.url, expiresAt: entry.expiresAt })
      restored++
    }
    while (remoteUrlCache.size > REMOTE_URL_CACHE_MAX) {
      const oldestKey = remoteUrlCache.keys().next().value
      if (oldestKey === undefined) break
      remoteUrlCache.delete(oldestKey)
    }
    if (restored) Logger.info(`[STRM-PRELOAD] Restored ${restored} signed URL(s) from disk cache`)
  } catch (error) {
    Logger.debug(`[STRM-PRELOAD] Unable to read URL cache from disk: ${error.message || error}`)
  }
}

function schedulePersist() {
  if (!PERSIST_URL_CACHE || persistWriteTimer) return
  persistWriteTimer = setTimeout(() => {
    persistWriteTimer = null
    persistCacheNow()
  }, PERSIST_DEBOUNCE_MS)
  if (typeof persistWriteTimer.unref === 'function') persistWriteTimer.unref()
}

/**
 * Write the still-valid cache entries to disk (0600). Never throws.
 */
function persistCacheNow() {
  if (!PERSIST_URL_CACHE) return
  const filePath = getPersistPath()
  if (!filePath) return
  try {
    const now = Date.now()
    const entries = []
    for (const [key, value] of remoteUrlCache) {
      if (value.expiresAt > now) entries.push({ key, url: value.url, expiresAt: value.expiresAt })
    }
    fs.writeFileSync(filePath, JSON.stringify(entries), { mode: 0o600 })
  } catch (error) {
    Logger.debug(`[STRM-PRELOAD] Unable to persist URL cache: ${error.message || error}`)
  }
}

function cacheRemoteUrl(remoteUrl, resolvedUrl) {
  if (!resolvedUrl || resolvedUrl === remoteUrl) return

  // Signed URLs expose expiry as `t` (115-style) or `Expires`/`expires` (Quark/OSS-style, Unix time).
  // Never retain a URL beyond its own expiry; otherwise keep it briefly.
  let expiresAt
  try {
    const parsed = new URL(resolvedUrl)
    const tParam = Number(parsed.searchParams.get('t'))
    const expiresParam = Number(parsed.searchParams.get('Expires') ?? parsed.searchParams.get('expires'))
    const signedExpiry = Number.isFinite(tParam) && tParam > 0 ? tParam : Number.isFinite(expiresParam) && expiresParam > 0 ? expiresParam : NaN
    expiresAt = Number.isFinite(signedExpiry) ? signedExpiry * 1000 - 30_000 : Date.now() + 5 * 60_000
  } catch (error) {
    // Malformed resolved URL: nothing safe to cache.
    return
  }
  if (expiresAt <= Date.now()) return

  remoteUrlCache.delete(remoteUrl)
  remoteUrlCache.set(remoteUrl, { url: resolvedUrl, expiresAt })
  while (remoteUrlCache.size > REMOTE_URL_CACHE_MAX) {
    const oldestKey = remoteUrlCache.keys().next().value
    if (oldestKey === undefined) break
    remoteUrlCache.delete(oldestKey)
    clearRefreshTimer(oldestKey)
  }
  scheduleRefresh(remoteUrl)
  schedulePersist()
}

/**
 * Cancel a pending refresh-ahead timer (no-op when there is none).
 *
 * @param {string} remoteUrl
 */
function clearRefreshTimer(remoteUrl) {
  const timer = refreshTimers.get(remoteUrl)
  if (!timer) return
  clearTimeout(timer)
  refreshTimers.delete(remoteUrl)
}

/**
 * Schedule a background refresh of a cached signed URL shortly before it
 * expires, so playback never waits for the STRM -> OpenList -> CDN chain again.
 * Disabled with STRM_URL_REFRESH_AHEAD=0.
 *
 * @param {string} remoteUrl
 */
function scheduleRefresh(remoteUrl) {
  if (process.env.STRM_URL_REFRESH_AHEAD === '0') return
  const cached = remoteUrlCache.get(remoteUrl)
  if (!cached) return

  clearRefreshTimer(remoteUrl)
  const delay = cached.expiresAt - Date.now() - REFRESH_AHEAD_MS
  // Too close to expiry: the next request will re-resolve anyway.
  if (delay <= 0) return

  const timer = setTimeout(() => {
    refreshTimers.delete(remoteUrl)
    refreshSignedUrl(remoteUrl).catch((error) => {
      Logger.debug(`[STRM-PRELOAD] Refresh-ahead failed: ${error.message || error}`)
    })
  }, delay)
  if (typeof timer.unref === 'function') timer.unref()
  refreshTimers.set(remoteUrl, timer)
}

/**
 * Re-run the redirect chain for a cached URL and replace the cached entry.
 * Uses a 1-byte range request, so it costs one round trip and no bandwidth.
 *
 * @param {string} remoteUrl
 */
async function refreshSignedUrl(remoteUrl) {
  if (!remoteUrl || warmingUrls.has(remoteUrl)) return
  warmingUrls.add(remoteUrl)
  let remoteRes = null
  try {
    remoteRes = await axios({
      method: 'get',
      url: remoteUrl,
      responseType: 'stream',
      maxRedirects: 10,
      timeout: UPSTREAM_TIMEOUTS.warm,
      headers: {
        'User-Agent': 'Mozilla/5.0 Audiobookshelf STRM Refresh',
        'Accept-Encoding': 'identity',
        Range: 'bytes=0-1'
      },
      validateStatus: (status) => status >= 200 && status < 400,
      ...AGENT_CONFIG, ...UPSTREAM_PROXY_CONFIG
    })
    const resolvedUrl = extractResolvedUrl(remoteRes)
    if (resolvedUrl) {
      cacheRemoteUrl(remoteUrl, resolvedUrl)
      Logger.info('[STRM-PRELOAD] Refreshed signed URL ahead of expiry (query redacted)')
    }
  } finally {
    warmingUrls.delete(remoteUrl)
    try {
      remoteRes?.data?.destroy()
    } catch (error) {}
  }
}

/**
 * Strip query strings from a URL for logging (signed params are credentials).
 *
 * @param {string} url
 * @returns {string}
 */
function redactUrl(url) {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    if (parsed.search) parsed.search = '?redacted'
    return parsed.toString()
  } catch (error) {
    return String(url).replace(/\?.*$/, '?redacted')
  }
}

/**
 * Describe a path/URL for logs. Local paths are reduced to their basename unless
 * STRM_LOG_FULL_PATH=1 is set; remote URLs always have their query redacted.
 *
 * @param {string} value
 * @returns {string}
 */
function describePath(value) {
  if (!value) return ''
  if (isUrl(value)) {
    if (process.env.STRM_LOG_FULL_REDIRECT_URL === '1') return value
    return redactUrl(value)
  }
  if (process.env.STRM_LOG_FULL_PATH === '1') return value
  return Path.basename(value)
}

/**
 * Pick the audio file that contains `currentTime`, using the cumulative
 * durations of the tracklist. Used to prewarm the track a user will actually
 * resume, instead of blindly warming the first file.
 *
 * @param {Array<{index:number, duration:number, exclude?:boolean}>} audioFiles
 * @param {number} currentTime seconds
 * @returns {number} index into the sorted, non-excluded array (-1 when empty)
 */
function pickResumeFileIndex(audioFiles, currentTime) {
  const files = (Array.isArray(audioFiles) ? audioFiles : [])
    .filter((audioFile) => audioFile && !audioFile.exclude)
    .sort((a, b) => Number(a.index) - Number(b.index))
  if (!files.length) return -1

  const position = Number(currentTime)
  if (!Number.isFinite(position) || position <= 0) return 0

  let offset = 0
  for (let i = 0; i < files.length; i++) {
    const duration = Number(files[i].duration)
    const known = Number.isFinite(duration) && duration > 0
    if (known && position < offset + duration) return i
    if (known) offset += duration
  }
  // Position past everything we know about: the last file is the best guess.
  return offset > 0 ? files.length - 1 : 0
}
module.exports.pickResumeFileIndex = pickResumeFileIndex

/**
 * Render a Range header for logs. `bytes=0-` means the player restarted from the
 * beginning (a retry loop); `bytes=123-` means it seeked. Without the value the
 * log cannot tell those apart.
 *
 * @param {string} [range]
 * @returns {string}
 */
function describeRange(range) {
  if (!range) return 'none'
  return String(range).slice(0, 40)
}
module.exports.describeRange = describeRange

// Cached parse of STRM_DIRECT_URL_MAP. getCloudDirectUrl is called for every
// audio file during direct-play checks, so re-parsing the env var each time is
// pure overhead on large libraries.
let directUrlMapCache = { raw: null, map: [] }

/**
 * Parse STRM_DIRECT_URL_MAP env var.
 * Format: /local/path=http://host:port/url[,/other=http://...]
 * Example: /CloudNAS=http://192.168.1.100:19798/dav
 *
 * @returns {{ localPrefix: string, urlPrefix: string }[]}
 */
function parseDirectUrlMap() {
  const raw = process.env.STRM_DIRECT_URL_MAP || ''
  if (directUrlMapCache.raw === raw) return directUrlMapCache.map

  const map = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const sep = entry.indexOf('=')
      if (sep < 1) return null
      return {
        localPrefix: filePathToPOSIX(entry.slice(0, sep).trim()),
        urlPrefix: entry.slice(sep + 1).trim().replace(/\/+$/, '')
      }
    })
    .filter(Boolean)

  directUrlMapCache = { raw, map }
  return map
}

/**
 * If the given local file path is under a configured cloud mount prefix,
 * return the corresponding direct HTTP URL. Otherwise return null.
 *
 * Set env var STRM_DIRECT_URL_MAP to enable, e.g.:
 *   STRM_DIRECT_URL_MAP=/CloudNAS=http://192.168.1.100:19798/dav
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function getCloudDirectUrl(filePath) {
  if (!filePath) return null
  const posixPath = filePathToPOSIX(filePath)
  for (const { localPrefix, urlPrefix } of parseDirectUrlMap()) {
    if (posixPath === localPrefix || posixPath.startsWith(localPrefix + '/')) {
      const relative = posixPath.slice(localPrefix.length)
      return urlPrefix + relative
    }
  }
  return null
}
module.exports.getCloudDirectUrl = getCloudDirectUrl

/**
 * Check whether a local path falls under any configured cloud mount prefix.
 * Used to force direct-play for cloud files regardless of MIME type.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isCloudMountPath(filePath) {
  return getCloudDirectUrl(filePath) !== null
}
module.exports.isCloudMountPath = isCloudMountPath

function isStrmPath(path) {
  return Path.extname(path || '').toLowerCase() === '.strm'
}
module.exports.isStrmPath = isStrmPath

function isUrl(input) {
  return /^https?:\/\//i.test(input)
}
module.exports.isUrl = isUrl

function parseEnvList(value, fallback = []) {
  if (value === undefined) return fallback
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizePathPrefix(prefix) {
  return prefix.replace(/\\/g, '/').replace(/\/+$/, '')
}

function pathStartsWithPrefix(path, prefix) {
  const normalizedPath = normalizePathPrefix(path || '')
  const normalizedPrefix = normalizePathPrefix(prefix || '')
  return !!normalizedPrefix && (normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`))
}

function isProbeSkippedPath(path) {
  const prefixes = parseEnvList(process.env.STRM_SCAN_SKIP_PROBE_PATHS, DEFAULT_PROBE_SKIP_PREFIXES)
  return prefixes.some((prefix) => pathStartsWithPrefix(path, prefix))
}
module.exports.isProbeSkippedPath = isProbeSkippedPath

/**
 * Hardening: a STRM file is user-supplied content, so an absolute target inside
 * it could point at any file readable by the ABS process. When
 * STRM_ALLOWED_LOCAL_ROOTS is configured (comma separated), local targets must
 * resolve inside one of those roots. Empty (default) keeps the old behaviour.
 *
 * @param {string} absolutePath
 * @returns {boolean}
 */
function isAllowedLocalTarget(absolutePath) {
  const roots = parseEnvList(process.env.STRM_ALLOWED_LOCAL_ROOTS, [])
    .map((root) => normalizePathPrefix(filePathToPOSIX(root)))
    .filter(Boolean)
  if (!roots.length) return true
  const normalized = normalizePathPrefix(filePathToPOSIX(absolutePath || ''))
  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`))
}
module.exports.isAllowedLocalTarget = isAllowedLocalTarget

function parseContentLength(headers = {}) {
  const contentLength = headers['content-length']
  if (contentLength === undefined || contentLength === null) return null

  const parsed = Number(contentLength)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

function parseRemoteFileSize(headers = {}) {
  const contentRange = headers['content-range']
  if (contentRange) {
    const match = String(contentRange).match(/\/(\d+)\s*$/)
    if (match) {
      const totalSize = Number(match[1])
      if (Number.isFinite(totalSize) && totalSize >= 0) return totalSize
    }
  }
  return parseContentLength(headers)
}
module.exports.parseRemoteFileSize = parseRemoteFileSize

function getFirstStrmTargetLine(contents) {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !STRM_COMMENT_PREFIXES.some((prefix) => line.startsWith(prefix)))
}
module.exports.getFirstStrmTargetLine = getFirstStrmTargetLine

async function readStrmTarget(strmPath) {
  const contents = await fs.readFile(strmPath, 'utf8')
  const target = getFirstStrmTargetLine(contents)
  if (!target) {
    throw new Error('STRM file does not contain a media target')
  }

  if (isUrl(target)) {
    return target
  }

  const resolved = filePathToPOSIX(Path.isAbsolute(target) ? Path.normalize(target) : Path.resolve(Path.dirname(strmPath), target))
  if (!isAllowedLocalTarget(resolved)) {
    throw new Error(`STRM local target is outside STRM_ALLOWED_LOCAL_ROOTS: ${resolved}`)
  }
  return resolved
}
module.exports.readStrmTarget = readStrmTarget

async function getStrmTargetSize(strmTarget) {
  if (isUrl(strmTarget)) {
    try {
      const response = await axios({
        method: 'head',
        url: strmTarget,
        maxRedirects: 5,
        timeout: UPSTREAM_TIMEOUTS.probe,
        headers: {
          'User-Agent': 'Mozilla/5.0 Audiobookshelf STRM Scanner'
        },
        validateStatus: (status) => status >= 200 && status < 400,
        ...AGENT_CONFIG, ...UPSTREAM_PROXY_CONFIG
      })

      const contentLength = parseRemoteFileSize(response.headers)
      if (contentLength !== null) return contentLength
    } catch (error) {}

    try {
      const response = await axios({
        method: 'get',
        url: strmTarget,
        maxRedirects: 5,
        timeout: UPSTREAM_TIMEOUTS.probe,
        responseType: 'stream',
        headers: {
          Range: 'bytes=0-0',
          'User-Agent': 'Mozilla/5.0 Audiobookshelf STRM Scanner'
        },
        validateStatus: (status) => status >= 200 && status < 400,
        ...AGENT_CONFIG, ...UPSTREAM_PROXY_CONFIG
      })

      const contentLength = parseRemoteFileSize(response.headers)
      response.data.destroy()
      if (contentLength !== null) return contentLength
    } catch (error) {}

    return null
  }

  try {
    const stats = await fs.stat(strmTarget)
    if (!Number.isFinite(stats.size) || stats.size < 0) return null
    return stats.size
  } catch (error) {
    return null
  }
}
module.exports.getStrmTargetSize = getStrmTargetSize

/**
 * Map an axios failure onto an HTTP status for the client.
 * Upstream status wins; timeouts become 504 so players can distinguish a slow
 * cloud from a broken link.
 *
 * @param {any} error
 * @returns {number}
 */
function mapErrorStatus(error) {
  const upstreamStatus = error?.response?.status
  if (upstreamStatus) return upstreamStatus
  const code = error?.code
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ERR_CANCELED') return 504
  return 502
}
module.exports.mapErrorStatus = mapErrorStatus

function extractResolvedUrl(remoteRes) {
  return remoteRes?.request?.res?.responseUrl || remoteRes?.request?._redirectable?._currentUrl || null
}

/**
 * Is this failure worth one more attempt?
 * Cross-border links routinely drop a connection or answer 502/503 once and then
 * work; auth and 404 style failures are permanent and must not be retried.
 *
 * @param {any} error
 * @returns {boolean}
 */
function isTransientUpstreamError(error) {
  const status = error?.response?.status
  if (status) return status >= 500 || status === 408 || status === 429
  const transientCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ERR_SOCKET_CLOSED']
  return transientCodes.includes(error?.code)
}
module.exports.isTransientUpstreamError = isTransientUpstreamError

const AUDIO_MIME_BY_EXT = {
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
  mpeg: 'audio/mpeg',
  mpg: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  wav: 'audio/wav',
  aac: 'audio/aac',
  mka: 'audio/x-matroska',
  webm: 'audio/webm',
  webma: 'audio/webm',
  wma: 'audio/x-ms-wma',
  aiff: 'audio/x-aiff',
  aif: 'audio/x-aiff',
  caf: 'audio/x-caf',
  awb: 'audio/amr-wb'
}

/**
 * Proxy a remote URL to the client, forwarding Range requests for seek support.
 * Follows redirects server-side so the client only ever talks to ABS.
 *
 * @param {string} remoteUrl
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function proxyRemoteStream(remoteUrl, req, res) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 Audiobookshelf STRM Relay',
    // Do not let axios negotiate gzip for byte ranges. Audio players need the
    // original byte offsets and the upstream Content-Range header.
    'Accept-Encoding': 'identity'
  }
  const requestHeaderMap = { range: 'Range', 'if-range': 'If-Range', 'if-modified-since': 'If-Modified-Since' }
  for (const [sourceHeader, targetHeader] of Object.entries(requestHeaderMap)) {
    if (req.headers[sourceHeader]) {
      headers[targetHeader] = req.headers[sourceHeader]
    }
  }

  const requestRemoteStream = (url) =>
    axios({
      method: 'get',
      url,
      responseType: 'stream',
      maxRedirects: 10,
      timeout: UPSTREAM_TIMEOUTS.stream,
      headers,
      validateStatus: (status) => status >= 200 && status < 400,
      ...AGENT_CONFIG, ...UPSTREAM_PROXY_CONFIG
    })

  // Cold path: re-check the cache inside the exclusive section so a burst of
  // concurrent requests for the same track performs exactly one resolution.
  const resolveRemote = async () => {
    const freshCachedUrl = getCachedRemoteUrl(remoteUrl)
    const remoteRes = await requestRemoteStream(freshCachedUrl || remoteUrl)
    const resolvedUrl = extractResolvedUrl(remoteRes)
    if (resolvedUrl) {
      cacheRemoteUrl(remoteUrl, resolvedUrl)
    }
    return remoteRes
  }

  // A speculative warm for this exact URL competes for the same (rate-limited)
  // upstream connection — OpenList/Quark answer 500 or hang when that happens.
  // The real request always wins: cancel the warm before touching the cache.
  if (cancelWarm(remoteUrl)) {
    Logger.info('[STRM-PLAY] Cancelled an in-flight prewarm competing with playback')
  }

  const cachedUrl = getCachedRemoteUrl(remoteUrl) || (await waitForWarm(remoteUrl))
  const attemptStartedAt = Date.now()

  let remoteRes
  try {
    remoteRes = cachedUrl ? await requestRemoteStream(cachedUrl) : await runExclusive(remoteUrl, resolveRemote)
  } catch (error) {
    // A cached signed URL may have been invalidated early. Retry once through
    // the original STRM target so playback can recover without rescanning.
    if (cachedUrl && [401, 403, 404].includes(error.response?.status)) {
      remoteUrlCache.delete(remoteUrl)
      try {
        remoteRes = await runExclusive(remoteUrl, resolveRemote)
      } catch (retryError) {
        const status = mapErrorStatus(retryError)
        Logger.warn(`[STRM-PLAY] Retry through original target failed: status=${status}`)
        return res.sendStatus(status)
      }
    } else if (isTransientUpstreamError(error) && STREAM_RETRY_COUNT > 0 && Date.now() - attemptStartedAt < RETRY_FAST_FAIL_MS) {
      // Cross-border links drop a connection or answer 502/503 *quickly* and then
      // work. One retry usually recovers; STRM_STREAM_RETRY=0 disables it.
      // Only retry fast failures: retrying after a 15s timeout just doubles the
      // wait before the user sees an error.
      Logger.warn(`[STRM-PLAY] Transient upstream failure (status=${error.response?.status || 'n/a'} code=${error.code || 'n/a'} after ${Date.now() - attemptStartedAt}ms), retrying once`)
      remoteUrlCache.delete(remoteUrl)
      try {
        remoteRes = await runExclusive(remoteUrl, resolveRemote)
      } catch (retryError) {
        const status = mapErrorStatus(retryError)
        Logger.warn(`[STRM-PLAY] Retry failed: status=${status}`)
        return res.sendStatus(status)
      }
    } else {
      const status = mapErrorStatus(error)
      const elapsed = Date.now() - attemptStartedAt
      Logger.warn(`[STRM-PLAY] Upstream request failed: status=${status} code=${error.code || 'n/a'} elapsed=${elapsed}ms`)
      return res.sendStatus(status)
    }
  }

  const resolvedUrl = extractResolvedUrl(remoteRes)
  let sourceHost = 'unknown'
  let resolvedHost = 'unknown'
  try {
    sourceHost = new URL(remoteUrl).host
    resolvedHost = new URL(resolvedUrl || remoteUrl).host
  } catch (error) {}
  const wasRedirected = !!resolvedUrl && resolvedUrl !== remoteUrl
  const redirectTarget = process.env.STRM_LOG_FULL_REDIRECT_URL === '1' && resolvedUrl ? resolvedUrl : `${resolvedHost}${wasRedirected ? ' (signed query redacted)' : ''}`
  Logger.info(`[STRM-PLAY] redirect=${wasRedirected ? 'yes' : 'no'} target=${redirectTarget}`)
  Logger.info(
    `[STRM-PLAY] mode=proxy source=${sourceHost} resolved=${resolvedHost} cache=${cachedUrl ? 'hit' : 'miss'} status=${remoteRes.status} range=${describeRange(req.headers.range)}`
  )

  const passthroughHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'content-disposition']
  for (const header of passthroughHeaders) {
    const value = remoteRes.headers[header]
    if (value != null) res.setHeader(header, value)
  }

  // Fix Content-Type for strict players (iOS AVPlayer rejects generic
  // application/octet-stream that Quark's CDN returns for audio files).
  // Override based on the file extension from the STRM target URL.
  const extMatch = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(remoteUrl)
  const fixedMime = extMatch && AUDIO_MIME_BY_EXT[extMatch[1].toLowerCase()]
  if (fixedMime) {
    res.setHeader('content-type', fixedMime)
  }

  // Only advertise byte-range support when upstream really supports it.
  // Lying here makes players seek into a 200 full-body stream and stall.
  const upstreamSupportsRange = remoteRes.status === 206 || !!remoteRes.headers['content-range'] || !!remoteRes.headers['accept-ranges']
  if (!remoteRes.headers['accept-ranges'] && upstreamSupportsRange) {
    res.setHeader('Accept-Ranges', 'bytes')
  } else if (!upstreamSupportsRange) {
    Logger.warn(`[STRM-PLAY] upstream does not support byte ranges (status=${remoteRes.status}); seek may fail`)
  }

  res.status(remoteRes.status)
  remoteRes.data.on('error', (error) => {
    if (!res.headersSent) return res.sendStatus(502)
    res.destroy(error)
  })
  remoteRes.data.pipe(res)

  // Destroy the upstream stream when the *response* goes away (client aborted),
  // not on req 'close': a GET request's stream is already complete by the time
  // the body is streaming, and destroying on that would truncate playback.
  res.on('close', () => {
    if (res.writableEnded) return
    try {
      remoteRes.data.destroy()
    } catch (error) {}
  })
}
module.exports.proxyRemoteStream = proxyRemoteStream

/**
 * Pre-warm the resolved direct URL for the *next* track while the current one
 * is playing. Runs the same redirect chain as proxyRemoteStream (STRM URL ->
 * OpenList -> signed Quark URL) and populates remoteUrlCache, so when the
 * client requests the next track it hits the cache instead of waiting ~10s
 * for OpenList to call the Quark API again.
 *
 * Fire-and-forget: never throws, never blocks playback.
 * Disable with STRM_PRELOAD_NEXT=0; cap parallelism with STRM_PRELOAD_CONCURRENCY.
 *
 * @param {string} remoteUrl STRM target URL (pre-redirect)
 * @param {{ priority?: boolean }} [options] priority warms (session start / item
 *   open) skip the background limiter so a queued next-track warm cannot delay
 *   the track the user is actually about to play.
 */
async function warmRemoteUrl(remoteUrl, options = {}) {
  if (process.env.STRM_PRELOAD_NEXT === '0') return
  if (!remoteUrl || getCachedRemoteUrl(remoteUrl)) return
  // Dedupe concurrent warms for the same URL (client may request a track twice)
  if (warmingUrls.has(remoteUrl)) return
  warmingUrls.add(remoteUrl)

  // CancelToken so a real playback request can abort this speculative warm.
  const cancelSource = axios.CancelToken?.source ? axios.CancelToken.source() : null
  if (cancelSource) warmInflight.set(remoteUrl, cancelSource)

  let remoteRes = null
  try {
    const runWarm = async () => {
      remoteRes = await axios({
        method: 'get',
        url: remoteUrl,
        responseType: 'stream',
        maxRedirects: 10,
        timeout: UPSTREAM_TIMEOUTS.warm,
        headers: {
          'User-Agent': 'Mozilla/5.0 Audiobookshelf STRM Preload',
          'Accept-Encoding': 'identity',
          Range: 'bytes=0-1'
        },
        validateStatus: (status) => status >= 200 && status < 400,
        ...(cancelSource ? { cancelToken: cancelSource.token } : {}),
        ...AGENT_CONFIG, ...UPSTREAM_PROXY_CONFIG
      })
      const resolvedUrl = extractResolvedUrl(remoteRes)
      if (resolvedUrl) {
        cacheRemoteUrl(remoteUrl, resolvedUrl)
        Logger.info('[STRM-PRELOAD] Warmed next track (signed query redacted)')
      }
    }
    if (options.priority) {
      // User-initiated warm: skip the background queue.
      await runWarm()
    } else {
      await warmLimiter(runWarm)
    }
  } catch (error) {
    if (axios.isCancel?.(error) || error?.code === 'ERR_CANCELED') {
      Logger.info('[STRM-PRELOAD] Warm cancelled: a real playback request took over')
    } else {
      Logger.warn(`[STRM-PRELOAD] Warm failed: ${error.message || error}`)
    }
  } finally {
    warmingUrls.delete(remoteUrl)
    warmInflight.delete(remoteUrl)
    try {
      remoteRes?.data?.destroy()
    } catch (error) {}
  }
}
module.exports.warmRemoteUrl = warmRemoteUrl

/**
 * Cancel an in-flight speculative warm for this URL.
 * Called by proxyRemoteStream: OpenList/Quark cannot serve a speculative warm
 * and a real play request for the same track at the same time — the second one
 * comes back as 500 or hangs until timeout.
 *
 * @param {string} remoteUrl
 * @returns {boolean} true when a warm was actually cancelled
 */
function cancelWarm(remoteUrl) {
  const cancelSource = warmInflight.get(remoteUrl)
  if (!cancelSource) return false
  try {
    cancelSource.cancel('superseded by playback request')
  } catch (error) {}
  warmInflight.delete(remoteUrl)
  // Let waitForWarm stop waiting immediately.
  warmingUrls.delete(remoteUrl)
  return true
}
module.exports.cancelWarm = cancelWarm

/**
 * Wait for an in-flight warm of the same URL to complete (max timeoutMs),
 * so a track request doesn't start a duplicate upstream resolution while
 * a warm is already running. Returns the cached URL if available.
 */
async function waitForWarm(remoteUrl, timeoutMs = Number(process.env.STRM_WAIT_WARM_MS) || 20000) {
  if (!warmingUrls.has(remoteUrl)) return getCachedRemoteUrl(remoteUrl)
  const start = Date.now()
  while (warmingUrls.has(remoteUrl) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return getCachedRemoteUrl(remoteUrl)
}
module.exports.waitForWarm = waitForWarm

// Exposed for unit tests and diagnostics.
module.exports.describePath = describePath
module.exports.redactUrl = redactUrl
module.exports.parseDirectUrlMap = parseDirectUrlMap
module.exports.getCachedRemoteUrl = getCachedRemoteUrl
module.exports.cacheRemoteUrl = cacheRemoteUrl
module.exports.scheduleRefresh = scheduleRefresh
module.exports.refreshSignedUrl = refreshSignedUrl
module.exports.getRemoteUrlCacheSize = () => remoteUrlCache.size
module.exports.getRefreshTimerCount = () => refreshTimers.size
module.exports.persistCacheNow = persistCacheNow
module.exports.loadPersistedCache = loadPersistedCache
module.exports.clearRemoteUrlCache = () => {
  for (const timer of refreshTimers.values()) clearTimeout(timer)
  refreshTimers.clear()
  remoteUrlCache.clear()
  // Allow a fresh load from disk (used by tests and by "reset" diagnostics).
  persistLoaded = false
}
