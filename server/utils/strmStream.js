const Logger = require('../Logger')
const { isStrmPath, isUrl, readStrmTarget, proxyRemoteStream, getCloudDirectUrl, describePath } = require('./strmUtils')

/**
 * @typedef {Object} StrmStreamResult
 * @property {boolean} handled   True when the response has already been written.
 * @property {string} filePath   Path the caller should serve locally when `handled` is false.
 */

/**
 * Proxy through to the client, converting a thrown proxy error into a response
 * so callers never have to know about axios failure modes.
 *
 * @param {string} remoteUrl
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function proxyOrFail(remoteUrl, req, res) {
  try {
    await proxyRemoteStream(remoteUrl, req, res)
  } catch (error) {
    Logger.error(`[STRM-PLAY] Proxy failed for "${describePath(remoteUrl)}": ${error.message || error}`)
    if (!res.headersSent) res.sendStatus(502)
  }
}

/**
 * Single entry point for serving a media file that may be:
 *   1. a remote URL            -> proxy it (Range aware)
 *   2. a .strm file            -> resolve the first non-comment line, then 1. or 3.
 *   3. a cloud-mounted path    -> map to its direct HTTP URL (STRM_DIRECT_URL_MAP) and proxy
 *   4. anything else           -> return { handled: false } so the caller can
 *                                 use X-Accel or res.sendFile (Express handles Range).
 *
 * Keeping this in one place means SessionController, LibraryItemController and
 * ShareController behave identically, and a future change to STRM semantics is
 * a one-file edit instead of three (which also shrinks rebase conflicts).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} filePath
 * @returns {Promise<StrmStreamResult>}
 */
async function serveStrmStream(req, res, filePath) {
  const sourcePath = filePath
  if (!sourcePath) return { handled: false, filePath: sourcePath }

  if (isUrl(sourcePath)) {
    Logger.info(`[STRM-PLAY] mode=proxy-direct source=${describePath(sourcePath)} range=${req.headers.range ? 'yes' : 'no'}`)
    await proxyOrFail(sourcePath, req, res)
    return { handled: true, filePath: sourcePath }
  }

  if (isStrmPath(sourcePath)) {
    let strmTarget
    try {
      strmTarget = await readStrmTarget(sourcePath)
    } catch (error) {
      Logger.error(`[STRM-PLAY] Failed to read STRM file "${describePath(sourcePath)}": ${error.message || error}`)
      if (!res.headersSent) res.sendStatus(500)
      return { handled: true, filePath: sourcePath }
    }

    if (isUrl(strmTarget)) {
      Logger.info(`[STRM-PLAY] mode=proxy-strm source=${describePath(sourcePath)} range=${req.headers.range ? 'yes' : 'no'}`)
      await proxyOrFail(strmTarget, req, res)
      return { handled: true, filePath: strmTarget }
    }
    filePath = strmTarget
  }

  const cloudDirectUrl = getCloudDirectUrl(filePath)
  if (cloudDirectUrl) {
    Logger.info(`[STRM-PLAY] mode=cloud-http-map source=${describePath(filePath)} range=${req.headers.range ? 'yes' : 'no'}`)
    await proxyOrFail(cloudDirectUrl, req, res)
    return { handled: true, filePath: cloudDirectUrl }
  }

  return { handled: false, filePath }
}

module.exports = { serveStrmStream }
