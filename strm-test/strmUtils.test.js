// Unit tests for the pure parts of server/utils/strmUtils.js.
// Dependencies (axios / Logger / fsExtra / fileUtils) are stubbed so the suite
// runs with `node --test` and zero installed packages.
//
// Env must be set before the module is loaded: constants are read at require time.
process.env.STRM_URL_CACHE_MAX = '3'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs/promises')
const os = require('os')
const Path = require('path')

const { loadStrmModules } = require('./helpers/strmStubs')
const { strmUtils: S } = loadStrmModules()

const posix = (value) => String(value).replace(/\\/g, '/')

test('STRM_DIRECT_URL_MAP: 多段映射 / 尾斜杠归一化 / 前缀边界', () => {
  process.env.STRM_DIRECT_URL_MAP = ' /CloudNAS=http://192.168.1.10:19798/dav/ , /mnt/media=http://host:8080/u '
  assert.strictEqual(S.getCloudDirectUrl('/CloudNAS/有声书/a.m4a'), 'http://192.168.1.10:19798/dav/有声书/a.m4a')
  assert.strictEqual(S.getCloudDirectUrl('/mnt/media/b.mp3'), 'http://host:8080/u/b.mp3')
  // 前缀边界：/CloudNAS2 不能被 /CloudNAS 命中
  assert.strictEqual(S.getCloudDirectUrl('/CloudNAS2/a.m4a'), null)
  assert.strictEqual(S.getCloudDirectUrl('/other/a.m4a'), null)
  assert.strictEqual(S.getCloudDirectUrl(''), null)
  // 反斜杠路径也要命中
  assert.strictEqual(S.getCloudDirectUrl('\\CloudNAS\\c.m4b'), 'http://192.168.1.10:19798/dav/c.m4b')
  // 映射变更后立即生效（缓存按原始字符串失效）
  process.env.STRM_DIRECT_URL_MAP = '/CloudNAS=http://new-host:1/dav'
  assert.strictEqual(S.getCloudDirectUrl('/CloudNAS/c.m4b'), 'http://new-host:1/dav/c.m4b')
})

test('parseDirectUrlMap: 非法条目被丢弃', () => {
  process.env.STRM_DIRECT_URL_MAP = 'nonsense,=http://x/y,/ok=http://ok/dav'
  assert.deepStrictEqual(S.parseDirectUrlMap(), [{ localPrefix: '/ok', urlPrefix: 'http://ok/dav' }])
})

test('isProbeSkippedPath: 默认 /CloudNAS 且遵守路径边界', () => {
  delete process.env.STRM_SCAN_SKIP_PROBE_PATHS
  assert.strictEqual(S.isProbeSkippedPath('/CloudNAS/a/b.m4a'), true)
  assert.strictEqual(S.isProbeSkippedPath('/CloudNAS'), true)
  assert.strictEqual(S.isProbeSkippedPath('/CloudNAS2/a.m4a'), false)
  assert.strictEqual(S.isProbeSkippedPath('/audiobooks/a.m4a'), false)

  process.env.STRM_SCAN_SKIP_PROBE_PATHS = '/mnt/cloud, /mnt/other/'
  assert.strictEqual(S.isProbeSkippedPath('/mnt/cloud/x.m4a'), true)
  assert.strictEqual(S.isProbeSkippedPath('/mnt/other/x.m4a'), true)
  assert.strictEqual(S.isProbeSkippedPath('/mnt/cloudx/x.m4a'), false)
  delete process.env.STRM_SCAN_SKIP_PROBE_PATHS
})

test('isStrmPath / isUrl', () => {
  assert.strictEqual(S.isStrmPath('/a/b.STRM'), true)
  assert.strictEqual(S.isStrmPath('/a/b.m4b'), false)
  assert.strictEqual(S.isStrmPath(null), false)
  assert.strictEqual(S.isUrl('https://x/y'), true)
  assert.strictEqual(S.isUrl('HTTP://x/y'), true)
  assert.strictEqual(S.isUrl('/local/y'), false)
})

test('readStrmTarget: 注释行 / 相对路径 / 绝对路径白名单', async () => {
  const dir = await fs.mkdtemp(Path.join(os.tmpdir(), 'strm-test-'))

  const urlStrm = Path.join(dir, 'url.strm')
  await fs.writeFile(urlStrm, '# comment\n// another comment\n\nhttps://cdn.example.com/x.m4a?sign=1\n')
  assert.strictEqual(await S.readStrmTarget(urlStrm), 'https://cdn.example.com/x.m4a?sign=1')

  const relStrm = Path.join(dir, 'rel.strm')
  await fs.writeFile(relStrm, './sub/c.m4b\r\n')
  assert.strictEqual(await S.readStrmTarget(relStrm), posix(Path.join(dir, 'sub/c.m4b')))

  const emptyStrm = Path.join(dir, 'empty.strm')
  await fs.writeFile(emptyStrm, '# only comments\n')
  await assert.rejects(() => S.readStrmTarget(emptyStrm), /does not contain a media target/)

  // 未配置白名单 = 保持旧行为（允许绝对路径）
  delete process.env.STRM_ALLOWED_LOCAL_ROOTS
  const absStrm = Path.join(dir, 'abs.strm')
  await fs.writeFile(absStrm, '/etc/passwd\n')
  assert.strictEqual(await S.readStrmTarget(absStrm), '/etc/passwd')

  // 配置白名单后，越界的绝对路径必须被拒绝
  process.env.STRM_ALLOWED_LOCAL_ROOTS = posix(dir)
  await assert.rejects(() => S.readStrmTarget(absStrm), /outside STRM_ALLOWED_LOCAL_ROOTS/)

  // 白名单内的绝对路径放行
  const insideStrm = Path.join(dir, 'inside.strm')
  await fs.writeFile(insideStrm, posix(Path.join(dir, 'sub/c.m4b')) + '\n')
  assert.strictEqual(await S.readStrmTarget(insideStrm), posix(Path.join(dir, 'sub/c.m4b')))

  // 白名单边界：同前缀不同目录不放行
  process.env.STRM_ALLOWED_LOCAL_ROOTS = posix(Path.join(dir, 'sub'))
  const siblingStrm = Path.join(dir, 'sibling.strm')
  await fs.writeFile(siblingStrm, posix(Path.join(dir, 'submarine/c.m4b')) + '\n')
  await assert.rejects(() => S.readStrmTarget(siblingStrm), /outside STRM_ALLOWED_LOCAL_ROOTS/)

  delete process.env.STRM_ALLOWED_LOCAL_ROOTS
  await fs.rm(dir, { recursive: true, force: true })
})

test('parseRemoteFileSize: Content-Range 总长优先于 Content-Length', () => {
  assert.strictEqual(S.parseRemoteFileSize({ 'content-range': 'bytes 0-0/1048576', 'content-length': '1' }), 1048576)
  assert.strictEqual(S.parseRemoteFileSize({ 'content-length': '2048' }), 2048)
  assert.strictEqual(S.parseRemoteFileSize({}), null)
  assert.strictEqual(S.parseRemoteFileSize({ 'content-length': 'abc' }), null)
  assert.strictEqual(S.parseRemoteFileSize({ 'content-length': '-1' }), null)
  assert.strictEqual(S.parseRemoteFileSize({ 'content-range': 'bytes 0-0/*' }), null)
})

test('remoteUrlCache: 签名过期、5 分钟兜底与 LRU 上限', () => {
  S.clearRemoteUrlCache()
  const future = Math.floor(Date.now() / 1000) + 3600

  S.cacheRemoteUrl('u1', `https://cdn.example.com/1.m4b?Expires=${future}&sign=a`)
  assert.ok(S.getCachedRemoteUrl('u1'))
  S.cacheRemoteUrl('u2', `https://cdn.example.com/2.m4b?t=${future}`)
  assert.ok(S.getCachedRemoteUrl('u2'))

  // 已过期的签名链接不缓存
  S.cacheRemoteUrl('u3', `https://cdn.example.com/3.m4b?Expires=${Math.floor(Date.now() / 1000) - 10}`)
  assert.strictEqual(S.getCachedRemoteUrl('u3'), null)

  // 无签名参数 → 5 分钟兜底缓存
  S.cacheRemoteUrl('u4', 'https://cdn.example.com/4.m4b')
  assert.ok(S.getCachedRemoteUrl('u4'))

  // 解析结果与原始 URL 相同 → 不缓存
  S.cacheRemoteUrl('u6', 'u6')
  assert.strictEqual(S.getCachedRemoteUrl('u6'), null)

  // STRM_URL_CACHE_MAX=3：插入第 4 条时淘汰最旧的
  S.cacheRemoteUrl('u5', 'https://cdn.example.com/5.m4b')
  assert.strictEqual(S.getRemoteUrlCacheSize(), 3)
  assert.strictEqual(S.getCachedRemoteUrl('u1'), null)
  assert.ok(S.getCachedRemoteUrl('u5'))
})

test('describePath: 远程查询串脱敏，本地路径默认只露文件名', () => {
  delete process.env.STRM_LOG_FULL_PATH
  delete process.env.STRM_LOG_FULL_REDIRECT_URL

  assert.strictEqual(S.describePath('https://cdn.example.com/x.m4b?sign=secret&Expires=1'), 'https://cdn.example.com/x.m4b?redacted')
  assert.strictEqual(S.describePath('/CloudNAS/有声书/a.m4a'), 'a.m4a')
  assert.strictEqual(S.describePath(''), '')

  process.env.STRM_LOG_FULL_PATH = '1'
  assert.strictEqual(S.describePath('/CloudNAS/a.m4a'), '/CloudNAS/a.m4a')
  delete process.env.STRM_LOG_FULL_PATH
})

test('mapErrorStatus: 上游状态优先，超时映射 504', () => {
  assert.strictEqual(S.mapErrorStatus({ response: { status: 403 } }), 403)
  assert.strictEqual(S.mapErrorStatus({ code: 'ETIMEDOUT' }), 504)
  assert.strictEqual(S.mapErrorStatus({ code: 'ECONNABORTED' }), 504)
  assert.strictEqual(S.mapErrorStatus({ code: 'ECONNREFUSED' }), 502)
  assert.strictEqual(S.mapErrorStatus(new Error('boom')), 502)
})
