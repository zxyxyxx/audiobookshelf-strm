// Regression tests for the upstream race that made playback fail with 500/504:
// a speculative prewarm and the real play request hitting OpenList/Quark for the
// same track at the same time.
const test = require('node:test')
const assert = require('node:assert')

const { loadStrmModules, makeRes, makeReq, streamOf } = require('./helpers/strmStubs')

const ENV_KEYS = [
  'STRM_UPSTREAM_PROXY',
  'STRM_STREAM_TIMEOUT_MS',
  'STRM_STREAM_RETRY',
  'STRM_RETRY_FAST_FAIL_MS',
  'STRM_PRELOAD_NEXT',
  'STRM_URL_CACHE_MAX'
]

function fresh(env = {}) {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.STRM_URL_CACHE_MAX = '50'
  Object.assign(process.env, env)
  return loadStrmModules()
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('cancelWarm: 真实播放请求会取消正在进行的预热', async () => {
  const { strmUtils: S, axios } = fresh({})
  const url = 'https://openlist.local/dav/race.m4a'
  let cancelled = false

  axios.setHandler((config) => {
    // The warm is a 1-byte range request: never resolve it.
    if (config.headers?.Range === 'bytes=0-1') {
      config.cancelToken.promise.catch(() => {
        cancelled = true
      })
      return new Promise(() => {})
    }
    return Promise.resolve({ status: 206, headers: {}, data: streamOf('x'), request: { res: { responseUrl: url } } })
  })

  const warmPromise = S.warmRemoteUrl(url, { priority: true })
  await wait(20)

  assert.strictEqual(S.cancelWarm(url), true, 'in-flight warm 应该能被取消')
  await warmPromise
  await wait(10)
  assert.strictEqual(cancelled, true, 'CancelToken 应该被触发')
  assert.strictEqual(S.cancelWarm(url), false, '已经结束的 warm 再取消应返回 false')
})

test('播放请求开始时自动取消同 URL 的预热', async () => {
  const { strmUtils: S, axios } = fresh({})
  const url = 'https://openlist.local/dav/race2.m4a'
  let warmCancelled = false

  axios.setHandler((config) => {
    // The warm is the 1-byte range probe; the player asks for a real range.
    if (config.headers?.Range === 'bytes=0-1' && config.cancelToken) {
      config.cancelToken.promise.catch(() => {
        warmCancelled = true
      })
      return new Promise(() => {})
    }
    return Promise.resolve({ status: 206, headers: { 'content-range': 'bytes 0-1023/2048' }, data: streamOf('abc'), request: { res: { responseUrl: url } } })
  })

  const warmPromise = S.warmRemoteUrl(url, { priority: true })
  await wait(20)

  const res = makeRes()
  await S.proxyRemoteStream(url, makeReq({ range: 'bytes=0-1023' }), res)
  assert.strictEqual(res.statusCode, 206, '真实请求必须成功，不能被预热拖死')
  await warmPromise
  await wait(10)
  assert.strictEqual(warmCancelled, true)
})

test('慢失败不重试（避免 15s 超时后再等一轮）', async () => {
  const { strmUtils: S, axios } = fresh({ STRM_RETRY_FAST_FAIL_MS: '10' })
  let attempts = 0
  axios.setHandler(async () => {
    attempts++
    await wait(30)
    const error = new Error('bad gateway')
    error.response = { status: 503 }
    throw error
  })

  const res = makeRes()
  await S.proxyRemoteStream('https://openlist.local/dav/slow.m4a', makeReq(), res)

  assert.strictEqual(res.statusCode, 503)
  assert.strictEqual(attempts, 1, '超过 STRM_RETRY_FAST_FAIL_MS 的失败不应重试')
})

test('快失败仍然重试一次', async () => {
  const { strmUtils: S, axios } = fresh({ STRM_RETRY_FAST_FAIL_MS: '5000' })
  let attempts = 0
  axios.setHandler(async () => {
    attempts++
    if (attempts === 1) {
      const error = new Error('bad gateway')
      error.response = { status: 503 }
      throw error
    }
    return { status: 200, headers: {}, data: streamOf('ok'), request: { res: { responseUrl: 'https://openlist.local/dav/fast.m4a' } } }
  })

  const res = makeRes()
  await S.proxyRemoteStream('https://openlist.local/dav/fast.m4a', makeReq(), res)

  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(attempts, 2)
})
