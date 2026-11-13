// Tests for the first-play (cold start) optimisations: keep-alive agents,
// refresh-ahead of cached signed URLs and priority warming.
process.env.STRM_URL_CACHE_MAX = '50'

const test = require('node:test')
const assert = require('node:assert')

const { loadStrmModules, makeRes, makeReq, streamOf } = require('./helpers/strmStubs')
const { strmUtils: S, axios } = loadStrmModules()

const futureSeconds = (offset = 3600) => Math.floor(Date.now() / 1000) + offset

test('keep-alive: 代理请求复用连接（首播少一次 TCP/TLS 握手）', async () => {
  S.clearRemoteUrlCache()
  axios.reset()
  const url = 'https://openlist.local/dav/a.m4a'
  axios.setHandler(async () => ({ status: 206, headers: { 'content-range': 'bytes 0-1/10' }, data: streamOf('x'), request: { res: { responseUrl: url } } }))

  await S.proxyRemoteStream(url, makeReq(), makeRes())

  const config = axios.calls[0]
  assert.ok(config.httpAgent, 'httpAgent 应存在')
  assert.ok(config.httpsAgent, 'httpsAgent 应存在')
  assert.strictEqual(config.httpAgent.keepAlive, true)
  assert.strictEqual(config.httpsAgent.keepAlive, true)
})

test('refresh-ahead: 提前刷新签名 URL 并写回缓存', async () => {
  S.clearRemoteUrlCache()
  axios.reset()
  const url = 'https://openlist.local/dav/b.m4a'
  const fresh = `https://cdn.example.com/b.m4a?Expires=${futureSeconds()}`
  axios.setHandler(async () => ({ status: 200, headers: {}, data: streamOf(''), request: { res: { responseUrl: fresh } } }))

  await S.refreshSignedUrl(url)

  assert.strictEqual(S.getCachedRemoteUrl(url), fresh)
  assert.strictEqual(axios.calls.length, 1)
  assert.strictEqual(axios.calls[0].headers.Range, 'bytes=0-1', '刷新只取 1 字节，不浪费带宽')
})

test('refresh-ahead: 距离过期还远则排定时器，太近则不排', () => {
  S.clearRemoteUrlCache()
  assert.strictEqual(S.getRefreshTimerCount(), 0)

  // 1 小时后过期 → 排一个提前刷新
  S.cacheRemoteUrl('far', `https://cdn.example.com/far.m4a?Expires=${futureSeconds(3600)}`)
  assert.strictEqual(S.getRefreshTimerCount(), 1)

  // 30 秒后过期，小于默认 60 秒提前量 → 不排（下一次请求会自行解析）
  S.cacheRemoteUrl('near', `https://cdn.example.com/near.m4a?Expires=${futureSeconds(30)}`)
  assert.strictEqual(S.getRefreshTimerCount(), 1)

  // 清空缓存必须同时清掉定时器
  S.clearRemoteUrlCache()
  assert.strictEqual(S.getRefreshTimerCount(), 0)
})

test('priority warm: 绕过后台队列直接预热并填充缓存', async () => {
  S.clearRemoteUrlCache()
  axios.reset()
  delete process.env.STRM_PRELOAD_NEXT
  const url = 'https://openlist.local/dav/c.m4a'
  const signed = `https://cdn.example.com/c.m4a?Expires=${futureSeconds()}`
  axios.setHandler(async () => ({ status: 200, headers: {}, data: streamOf(''), request: { res: { responseUrl: signed } } }))

  await S.warmRemoteUrl(url, { priority: true })

  assert.strictEqual(axios.calls.length, 1)
  assert.strictEqual(S.getCachedRemoteUrl(url), signed)
})

test('warm 去重: 同一 URL 并发预热只发一次上游请求', async () => {
  S.clearRemoteUrlCache()
  axios.reset()
  delete process.env.STRM_PRELOAD_NEXT
  const url = 'https://openlist.local/dav/d.m4a'
  const signed = `https://cdn.example.com/d.m4a?Expires=${futureSeconds()}`
  axios.setHandler(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return { status: 200, headers: {}, data: streamOf(''), request: { res: { responseUrl: signed } } }
  })

  await Promise.all([S.warmRemoteUrl(url), S.warmRemoteUrl(url), S.warmRemoteUrl(url)])

  assert.strictEqual(axios.calls.length, 1)
})

test('STRM_PRELOAD_NEXT=0 时完全不预热', async () => {
  S.clearRemoteUrlCache()
  axios.reset()
  process.env.STRM_PRELOAD_NEXT = '0'
  await S.warmRemoteUrl('https://openlist.local/dav/e.m4a', { priority: true })
  assert.strictEqual(axios.calls.length, 0)
  delete process.env.STRM_PRELOAD_NEXT
})
