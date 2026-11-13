// Tests for the optional on-disk signed-URL cache (survives container restarts,
// which is exactly when Watchtower image updates happen).
process.env.STRM_URL_CACHE_MAX = '50'
process.env.STRM_PERSIST_URL_CACHE = '1'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const Path = require('path')

// The cache file lives next to the metadata directory; ABS exposes it as a global.
const tmpRoot = fs.mkdtempSync(Path.join(os.tmpdir(), 'strm-persist-'))
global.MetadataPath = tmpRoot

const { loadStrmModules } = require('./helpers/strmStubs')
const { strmUtils: S } = loadStrmModules()

const cacheFile = Path.join(tmpRoot, 'strm-url-cache.json')
const futureSeconds = (offset = 3600) => Math.floor(Date.now() / 1000) + offset

test('persist: 写入磁盘后可在内存清空后恢复', () => {
  S.clearRemoteUrlCache()
  const signed = `https://cdn.example.com/a.m4b?Expires=${futureSeconds()}`
  S.cacheRemoteUrl('https://openlist.local/dav/a.m4b', signed)
  S.persistCacheNow()

  assert.ok(fs.existsSync(cacheFile), '缓存文件应已写入')
  const entries = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
  assert.strictEqual(entries.length, 1)
  assert.strictEqual(entries[0].url, signed)

  // 模拟重启：内存清空 + 重新加载（getCachedRemoteUrl 也会惰性触发加载）
  S.clearRemoteUrlCache()
  assert.strictEqual(S.getRemoteUrlCacheSize(), 0)

  S.loadPersistedCache()
  assert.strictEqual(S.getCachedRemoteUrl('https://openlist.local/dav/a.m4b'), signed)
})

test('persist: 过期条目在加载时被丢弃', () => {
  S.clearRemoteUrlCache()
  const expired = `https://cdn.example.com/b.m4b?Expires=${futureSeconds(-60)}`
  fs.writeFileSync(cacheFile, JSON.stringify([{ key: 'https://openlist.local/dav/b.m4b', url: expired, expiresAt: Date.now() - 60_000 }]))

  S.loadPersistedCache()
  assert.strictEqual(S.getCachedRemoteUrl('https://openlist.local/dav/b.m4b'), null)
})

test('persist: 损坏的缓存文件不影响运行', () => {
  S.clearRemoteUrlCache()
  fs.writeFileSync(cacheFile, '{not json')
  assert.doesNotThrow(() => S.loadPersistedCache())
  assert.strictEqual(S.getRemoteUrlCacheSize(), 0)
})

test('persist: 写盘只保留未过期条目', () => {
  S.clearRemoteUrlCache()
  const live = `https://cdn.example.com/live.m4b?Expires=${futureSeconds()}`
  S.cacheRemoteUrl('https://openlist.local/dav/live.m4b', live)
  // 手工塞入一条已过期条目（绕过 cacheRemoteUrl 的过期检查）
  S.cacheRemoteUrl('https://openlist.local/dav/stale.m4b', `https://cdn.example.com/stale.m4b?Expires=${futureSeconds()}`)
  S.persistCacheNow()

  const entries = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
  assert.strictEqual(entries.length, 2)
  assert.ok(entries.every((entry) => entry.expiresAt > Date.now()))
})
