// Tests for the build metadata reported by /api/status and the startup log,
// plus a guard that every STRM_* environment variable is documented.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const Path = require('path')

const buildPath = Path.join(__dirname, '..', 'server', 'utils', 'strmBuild.js')
const pkg = require('../package.json')
const ENV_KEYS = ['STRM_GIT_SHA', 'STRM_UPSTREAM_TAG', 'STRM_BUILD_TIME']

/** Load a fresh copy of the module with exactly the given env. */
function fresh(env = {}) {
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, env)
  delete require.cache[buildPath]
  return require(buildPath)
}

test('build info: 本地开发（无构建参数）也能给出 base 版本', () => {
  const { getStrmBuildInfo, getStrmBuildLine } = fresh({})
  const info = getStrmBuildInfo()
  assert.strictEqual(info.isStrmFork, true)
  assert.strictEqual(info.baseVersion, pkg.version)
  assert.strictEqual(info.upstreamTag, null)
  assert.strictEqual(info.gitSha, null)
  assert.strictEqual(info.builtAt, null)
  assert.match(getStrmBuildLine(), /upstream=unknown sha=unknown/)
})

test('build info: 镜像构建注入的 upstream tag / sha / 时间', () => {
  const { getStrmBuildInfo, getStrmBuildLine } = fresh({
    STRM_GIT_SHA: '467e7cedf49dcdc6877c104b6748876fb5e194eb',
    STRM_UPSTREAM_TAG: 'v2.37.2',
    STRM_BUILD_TIME: '2026-11-13T23:00:00Z'
  })
  const info = getStrmBuildInfo()
  assert.strictEqual(info.upstreamTag, 'v2.37.2')
  assert.strictEqual(info.gitSha, '467e7cedf49dcdc6877c104b6748876fb5e194eb')
  assert.strictEqual(info.shortSha, '467e7ce')
  assert.strictEqual(info.builtAt, '2026-11-13T23:00:00Z')

  const line = getStrmBuildLine()
  assert.match(line, /base=v\d+\.\d+\.\d+/)
  assert.match(line, /upstream=v2\.37\.2/)
  assert.match(line, /sha=467e7ce/)
  assert.match(line, /built=2026-11-13T23:00:00Z/)
})

test('build info: 空白环境变量按未设置处理', () => {
  const { getStrmBuildInfo } = fresh({ STRM_GIT_SHA: '   ', STRM_UPSTREAM_TAG: '  ' })
  const info = getStrmBuildInfo()
  assert.strictEqual(info.gitSha, null)
  assert.strictEqual(info.upstreamTag, null)
})

test('文档一致性: server/ 里每个 STRM_* 环境变量都写进了 nas/README.md', () => {
  const root = Path.join(__dirname, '..')
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = Path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', 'dist-server'].includes(entry.name)) continue
        walk(full)
      } else if (entry.name.endsWith('.js')) {
        files.push(full)
      }
    }
  }
  walk(Path.join(root, 'server'))

  const used = new Set()
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(/process\.env\.(STRM_[A-Z0-9_]+)/g)) used.add(match[1])
  }
  assert.ok(used.size > 20, `expected the STRM knob set, found ${used.size}`)

  const readme = fs.readFileSync(Path.join(root, 'nas', 'README.md'), 'utf8')
  const undocumented = [...used].filter((key) => !readme.includes(key)).sort()
  assert.deepStrictEqual(undocumented, [], `undocumented STRM env vars: ${undocumented.join(', ')}`)
})
