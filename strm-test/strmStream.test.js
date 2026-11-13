// Behaviour tests for proxyRemoteStream and the single-entry dispatcher
// (server/utils/strmStream.js). axios is stubbed, so no network is used.
process.env.STRM_URL_CACHE_MAX = '50'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs/promises')
const os = require('os')
const Path = require('path')

const { loadStrmModules, makeRes, makeReq, streamOf } = require('./helpers/strmStubs')
const { strmUtils: S, strmStream, axios, logs } = loadStrmModules()

const futureSeconds = () => Math.floor(Date.now() / 1000) + 3600

function okResponse(url, { status = 200, headers = {}, body = 'payload' } = {}) {
  return { status, headers, data: streamOf(body), request: { res: { responseUrl: url } } }
}

test('proxyRemoteStream: 206 Range 透传 + Content-Type 纠正 + Accept-Ranges', async () => {
  S.clearRemoteUrlCache()
  axios.reset()
  const url = 'https://openlist.local/dav/书/a.m4b'
  axios.setHandler(async () => okResponse(url, { status: 206, headers: { 'content-range': 'bytes 0-1023/1048576', 'content-type': 'application/octet-stream' } }))

  const req = makeReq({ range: 'bytes=0-1023', 'if-range': 'etag-1' })
  const res = makeRes()
  await S.proxyRemoteStream(url, req, res)

  assert.strictEqual(res.statusCode, 206)
  assert.strictEqual(res.headers['content-range'], 'bytes 0-1023/1048576')
  assert.strictEqual(res.headers['content-type'], 'audio/mp4', 'octet-stream 应按扩展名纠正为 audio/mp4')
  assert.strictEqual(res.headers['accept-ranges'], 'bytes')
  assert.strictEqual(axios.calls[0].headers.Range, 'bytes=0-1023')
  assert.strictEqual(axios.calls[0].headers['If-Range'], 'etag-1')
  assert.strictEqual(axios.calls[0].headers['Accept-Encoding'], 'identity')
})

test('proxyRemoteStream: 上游 200 且不支持 Range 时不谎报 Accept-Ranges', async () => {
  S.clearRemoteUrlCache()
  axios.reset()
  logs.length = 0
  const url = 'https://openlist.local/dav/b.mp3'
  axios.setHandler(async () => okResponse(url, { status: 200, headers: { 'content-type': 'audio/mpeg' } }))

  const res = makeRes()
  await S.proxyRemoteStream(url, makeReq({ range: 'bytes=0-100' }), res)

  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(res.headers['accept-ranges'], undefined)
  assert.ok(
    logs.some((entry) => entry.level === 'warn' && /does not support byte ranges/.test(entry.message)),
    '应记录不支持 Range 的告警'
  )
})

test('proxyRemoteStream: 并发冷请求只解析一次重定向链', async () => {
  S.clearRemoteUrlCache()
  axios.reset()
  const url = 'https://openlist.local/dav/c.m4a'
  const signed = `https://cdn.quark.example.com/c.m4a?Expires=${futureSeconds()}&sign=abc`

  axios.setHandler(async (config) => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return okResponse(config.url === url ? signed : config.url, { headers: { 'content-type': 'audio/mp4' } })
  })

  await Promise.all([0, 1, 2].map(() => S.proxyRemoteStream(url, makeReq(), makeRes())))

  assert.strictEqual(axios.callsTo(url).length, 1, '同一 URL 的冷解析应只发生一次')
  assert.strictEqual(axios.callsTo(signed).length, 2, '其余请求应命中缓存签名链接')
})

test('proxyRemoteStream: 缓存签名 403 时用原始目标重试一次', async () => {
  S.clearRemoteUrlCache()
  axios.reset()
  const url = 'https://openlist.local/dav/d.m4a'
  const signed = `https://cdn.quark.example.com/d.m4a?Expires=${futureSeconds()}`
  S.cacheRemoteUrl(url, signed)

  let firstSignedCall = true
  axios.setHandler(async (config) => {
    if (config.url === signed && firstSignedCall) {
      firstSignedCall = false
      const error = new Error('forbidden')
      error.response = { status: 403 }
      throw error
    }
    return okResponse(signed, { headers: { 'content-type': 'audio/mp4' } })
  })

  const res = makeRes()
  await S.proxyRemoteStream(url, makeReq(), res)

  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(axios.callsTo(url).length, 1, '重试应回到原始 STRM 目标')
})

test('proxyRemoteStream: 超时映射为 504，上游 5xx 原样透传', async () => {
  S.clearRemoteUrlCache()
  axios.reset()

  axios.setHandler(async () => {
    const error = new Error('timeout of 15000ms exceeded')
    error.code = 'ETIMEDOUT'
    throw error
  })
  const timeoutRes = makeRes()
  await S.proxyRemoteStream('https://openlist.local/dav/e.mp3', makeReq(), timeoutRes)
  assert.strictEqual(timeoutRes.statusCode, 504)

  S.clearRemoteUrlCache()
  axios.setHandler(async () => {
    const error = new Error('upstream exploded')
    error.response = { status: 503 }
    throw error
  })
  const upstreamRes = makeRes()
  await S.proxyRemoteStream('https://openlist.local/dav/f.mp3', makeReq(), upstreamRes)
  assert.strictEqual(upstreamRes.statusCode, 503)
})

test('serveStrmStream: 远程 URL 直接代理', async () => {
  S.clearRemoteUrlCache()
  axios.reset()
  const url = `https://cdn.example.com/g.m4b?Expires=${futureSeconds()}`
  axios.setHandler(async () => okResponse(url, { headers: { 'content-type': 'audio/mp4' } }))

  const res = makeRes()
  const result = await strmStream.serveStrmStream(makeReq(), res, url)

  assert.strictEqual(result.handled, true)
  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(res.headers['content-type'], 'audio/mp4')
})

test('serveStrmStream: .strm → 远程 URL 走代理（不再 302 泄露签名链）', async () => {
  S.clearRemoteUrlCache()
  axios.reset()
  const dir = await fs.mkdtemp(Path.join(os.tmpdir(), 'strm-stream-'))
  const strmPath = Path.join(dir, 'h.strm')
  const target = `https://cdn.example.com/h.m4b?Expires=${futureSeconds()}&sign=zzz`
  await fs.writeFile(strmPath, `${target}\n`)
  axios.setHandler(async () => okResponse(target, { headers: { 'content-type': 'audio/mp4' } }))

  const res = makeRes()
  const result = await strmStream.serveStrmStream(makeReq(), res, strmPath)

  assert.strictEqual(result.handled, true)
  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(axios.calls.length, 1)
  await fs.rm(dir, { recursive: true, force: true })
})

test('serveStrmStream: .strm → 本地路径交回调用方（X-Accel / sendFile）', async () => {
  axios.reset()
  const dir = await fs.mkdtemp(Path.join(os.tmpdir(), 'strm-local-'))
  const localTarget = Path.join(dir, 'i.m4b')
  const strmPath = Path.join(dir, 'i.strm')
  await fs.writeFile(strmPath, './i.m4b\n')

  const res = makeRes()
  const result = await strmStream.serveStrmStream(makeReq(), res, strmPath)

  assert.strictEqual(result.handled, false)
  assert.strictEqual(result.filePath, String(localTarget).replace(/\\/g, '/'))
  assert.strictEqual(axios.calls.length, 0)
  await fs.rm(dir, { recursive: true, force: true })
})

test('serveStrmStream: 云挂载路径按 STRM_DIRECT_URL_MAP 代理', async () => {
  S.clearRemoteUrlCache()
  axios.reset()
  process.env.STRM_DIRECT_URL_MAP = '/CloudNAS=http://192.168.1.10:19798/dav'
  const url = 'http://192.168.1.10:19798/dav/有声书/j.m4b'
  axios.setHandler(async () => okResponse(url, { headers: { 'content-type': 'audio/mp4' } }))

  const res = makeRes()
  const result = await strmStream.serveStrmStream(makeReq(), res, '/CloudNAS/有声书/j.m4b')

  assert.strictEqual(result.handled, true)
  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(axios.callsTo(url).length, 1)
  delete process.env.STRM_DIRECT_URL_MAP
})

test('serveStrmStream: 普通本地文件不接管', async () => {
  axios.reset()
  const result = await strmStream.serveStrmStream(makeReq(), makeRes(), '/audiobooks/plain.m4b')
  assert.strictEqual(result.handled, false)
  assert.strictEqual(result.filePath, '/audiobooks/plain.m4b')
  assert.strictEqual(axios.calls.length, 0)
})

test('serveStrmStream: 非法 .strm 返回 500 且不崩', async () => {
  axios.reset()
  const dir = await fs.mkdtemp(Path.join(os.tmpdir(), 'strm-bad-'))
  const strmPath = Path.join(dir, 'bad.strm')
  await fs.writeFile(strmPath, '# nothing here\n')

  const res = makeRes()
  const result = await strmStream.serveStrmStream(makeReq(), res, strmPath)

  assert.strictEqual(result.handled, true)
  assert.strictEqual(res.statusCode, 500)
  assert.strictEqual(axios.calls.length, 0)
  await fs.rm(dir, { recursive: true, force: true })
})

test('serveStrmStream: 代理抛错时兜底 502', async () => {
  S.clearRemoteUrlCache()
  axios.reset()
  const url = `https://cdn.example.com/k.m4b?Expires=${futureSeconds()}`
  axios.setHandler(async () => {
    const error = new Error('socket hang up')
    error.code = 'ECONNRESET'
    throw error
  })

  const res = makeRes()
  const result = await strmStream.serveStrmStream(makeReq(), res, url)

  assert.strictEqual(result.handled, true)
  assert.strictEqual(res.statusCode, 502)
})
