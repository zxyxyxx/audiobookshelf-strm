// Tests for cross-border / overseas network tuning: egress proxy, configurable
// timeouts and the transient-failure retry.
const test = require('node:test')
const assert = require('node:assert')

const { loadStrmModules, makeRes, makeReq, streamOf } = require('./helpers/strmStubs')

const ENV_KEYS = ['STRM_UPSTREAM_PROXY', 'STRM_STREAM_TIMEOUT_MS', 'STRM_STREAM_RETRY', 'STRM_WARM_TIMEOUT_MS', 'STRM_PROBE_TIMEOUT_MS', 'STRM_URL_CACHE_MAX']

/** Load a fresh module instance with exactly the given env. */
function fresh(env = {}) {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.STRM_URL_CACHE_MAX = '50'
  Object.assign(process.env, env)
  return loadStrmModules()
}

function okResponse(url, extra = {}) {
  return { status: 200, headers: {}, data: streamOf('payload'), request: { res: { responseUrl: url } }, ...extra }
}

test('STRM_UPSTREAM_PROXY=direct → 忽略环境里的 HTTP(S)_PROXY', async () => {
  const { strmUtils: S, axios } = fresh({ STRM_UPSTREAM_PROXY: 'direct' })
  axios.setHandler(async () => okResponse('https://cdn.example.com/a.m4b'))

  await S.proxyRemoteStream('https://cdn.example.com/a.m4b', makeReq(), makeRes())

  assert.strictEqual(axios.calls[0].proxy, false)
})

test('STRM_UPSTREAM_PROXY=http://user:pass@host:port → 带认证的代理配置', async () => {
  const { strmUtils: S, axios } = fresh({ STRM_UPSTREAM_PROXY: 'http://user:p%40ss@proxy.local:7890' })
  axios.setHandler(async () => okResponse('https://cdn.example.com/b.m4b'))

  await S.proxyRemoteStream('https://cdn.example.com/b.m4b', makeReq(), makeRes())

  assert.deepStrictEqual(axios.calls[0].proxy, {
    protocol: 'http',
    host: 'proxy.local',
    port: 7890,
    auth: { username: 'user', password: 'p@ss' }
  })
})

test('非法 STRM_UPSTREAM_PROXY 被忽略，不影响启动', () => {
  const { strmUtils: S } = fresh({ STRM_UPSTREAM_PROXY: 'not a url' })
  assert.strictEqual(typeof S.proxyRemoteStream, 'function')
})

test('超时可配置：跨洲部署可放宽到 45s', async () => {
  const { strmUtils: S, axios } = fresh({ STRM_STREAM_TIMEOUT_MS: '45000' })
  axios.setHandler(async () => okResponse('https://cdn.example.com/c.m4b'))

  await S.proxyRemoteStream('https://cdn.example.com/c.m4b', makeReq(), makeRes())

  assert.strictEqual(axios.calls[0].timeout, 45000)
})

test('瞬时失败（503）自动重试一次后成功', async () => {
  const { strmUtils: S, axios } = fresh({})
  let attempts = 0
  axios.setHandler(async () => {
    attempts++
    if (attempts === 1) {
      const error = new Error('bad gateway')
      error.response = { status: 503 }
      throw error
    }
    return okResponse('https://cdn.example.com/d.m4b')
  })

  const res = makeRes()
  await S.proxyRemoteStream('https://cdn.example.com/d.m4b', makeReq(), res)

  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(attempts, 2, '应重试一次')
})

test('连接被重置（ECONNRESET）也算瞬时失败', async () => {
  const { strmUtils: S, axios } = fresh({})
  let attempts = 0
  axios.setHandler(async () => {
    attempts++
    if (attempts === 1) {
      const error = new Error('socket hang up')
      error.code = 'ECONNRESET'
      throw error
    }
    return okResponse('https://cdn.example.com/e.m4b')
  })

  const res = makeRes()
  await S.proxyRemoteStream('https://cdn.example.com/e.m4b', makeReq(), res)

  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(attempts, 2)
})

test('STRM_STREAM_RETRY=0 关闭重试', async () => {
  const { strmUtils: S, axios } = fresh({ STRM_STREAM_RETRY: '0' })
  let attempts = 0
  axios.setHandler(async () => {
    attempts++
    const error = new Error('bad gateway')
    error.response = { status: 503 }
    throw error
  })

  const res = makeRes()
  await S.proxyRemoteStream('https://cdn.example.com/f.m4b', makeReq(), res)

  assert.strictEqual(res.statusCode, 503)
  assert.strictEqual(attempts, 1, '不应重试')
})

test('永久失败（403）不重试', async () => {
  const { strmUtils: S, axios } = fresh({})
  let attempts = 0
  axios.setHandler(async () => {
    attempts++
    const error = new Error('forbidden')
    error.response = { status: 403 }
    throw error
  })

  const res = makeRes()
  await S.proxyRemoteStream('https://cdn.example.com/g.m4b', makeReq(), res)

  assert.strictEqual(res.statusCode, 403)
  assert.strictEqual(attempts, 1)
})

test('isTransientUpstreamError: 5xx/408/429/网络错误为瞬时，4xx 为永久', () => {
  const { strmUtils: S } = fresh({})
  assert.strictEqual(S.isTransientUpstreamError({ response: { status: 503 } }), true)
  assert.strictEqual(S.isTransientUpstreamError({ response: { status: 408 } }), true)
  assert.strictEqual(S.isTransientUpstreamError({ response: { status: 429 } }), true)
  assert.strictEqual(S.isTransientUpstreamError({ response: { status: 404 } }), false)
  assert.strictEqual(S.isTransientUpstreamError({ response: { status: 403 } }), false)
  assert.strictEqual(S.isTransientUpstreamError({ code: 'ECONNRESET' }), true)
  assert.strictEqual(S.isTransientUpstreamError({ code: 'ETIMEDOUT' }), true)
  assert.strictEqual(S.isTransientUpstreamError({ code: 'ENOTFOUND' }), false)
})
