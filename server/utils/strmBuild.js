const { version } = require('../../package.json')

// Build metadata is injected by the Docker build (see build-strm-image.yml).
// In a local dev checkout none of these are set, which is fine: the log then
// shows "unknown" and the version from package.json.
const STRM_GIT_SHA = (process.env.STRM_GIT_SHA || '').trim()
const STRM_UPSTREAM_TAG = (process.env.STRM_UPSTREAM_TAG || '').trim()
const STRM_BUILD_TIME = (process.env.STRM_BUILD_TIME || '').trim()

/**
 * Identify exactly which upstream release + commit this build carries.
 * The point is to answer "which patch is this image running?" without guessing
 * from the image tag, which is what makes cross-border debugging painful.
 *
 * @returns {{ isStrmFork: boolean, baseVersion: string, upstreamTag: string|null, gitSha: string|null, shortSha: string|null, builtAt: string|null }}
 */
function getStrmBuildInfo() {
  return {
    isStrmFork: true,
    baseVersion: version,
    upstreamTag: STRM_UPSTREAM_TAG || null,
    gitSha: STRM_GIT_SHA || null,
    shortSha: STRM_GIT_SHA ? STRM_GIT_SHA.slice(0, 7) : null,
    builtAt: STRM_BUILD_TIME || null
  }
}

/**
 * One-line summary for the startup log.
 *
 * @returns {string}
 */
function getStrmBuildLine() {
  const info = getStrmBuildInfo()
  const parts = [`base=v${info.baseVersion}`, `upstream=${info.upstreamTag || 'unknown'}`, `sha=${info.shortSha || 'unknown'}`]
  if (info.builtAt) parts.push(`built=${info.builtAt}`)
  return `STRM build: ${parts.join(' ')}`
}

module.exports = { getStrmBuildInfo, getStrmBuildLine }
