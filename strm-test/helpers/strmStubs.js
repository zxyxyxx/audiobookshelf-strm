const Module = require('module')
const Path = require('path')
const fs = require('fs/promises')
const { Readable, Writable } = require('stream')

/**
 * Minimal axios stand-in. Tests register a handler; every call is recorded so
 * tests can assert on how many upstream requests were actually made.
 */
function makeAxios() {
  const calls = []
  const state = { handler: null }

  const axios = (config) => {
    calls.push(config)
    if (!state.handler) return Promise.reject(new Error('no axios handler registered'))
    return state.handler(config)
  }
  axios.calls = calls
  axios.setHandler = (fn) => {
    state.handler = fn
  }
  axios.reset = () => {
    calls.length = 0
  }
  axios.callsTo = (url) => calls.filter((c) => c.url === url)

  return axios
}

/**
 * Build a fake express Response that behaves enough like a writable stream.
 */
function makeRes() {
  const chunks = []
  const res = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    }
  })
  res.headers = {}
  res.headersSent = false
  res.setHeader = (key, value) => {
    res.headers[String(key).toLowerCase()] = value
    return res
  }
  res.getHeader = (key) => res.headers[String(key).toLowerCase()]
  res.removeHeader = (key) => delete res.headers[String(key).toLowerCase()]
  res.status = (code) => {
    res.statusCode = code
    return res
  }
  res.sendStatus = (code) => {
    res.statusCode = code
    res.headersSent = true
    res.end(String(code))
    return res
  }
  res.body = () => Buffer.concat(chunks).toString('utf8')
  res.on('error', () => {})
  return res
}

/**
 * Build a fake express Request carrying the headers the proxy inspects.
 */
function makeReq(headers = {}) {
  const req = { headers: {}, _closeHandlers: [] }
  for (const [key, value] of Object.entries(headers)) req.headers[key.toLowerCase()] = value
  req.on = (event, handler) => {
    if (event === 'close') req._closeHandlers.push(handler)
    return req
  }
  req.emitClose = () => req._closeHandlers.forEach((handler) => handler())
  return req
}

function streamOf(text) {
  return Readable.from([Buffer.from(text)])
}

/**
 * Load strmUtils / strmStream with their project dependencies stubbed out, so
 * the STRM logic can be unit tested without installing the full dependency tree.
 *
 * @returns {{ strmUtils: any, strmStream: any, axios: any, logs: any[] }}
 */
function loadStrmModules() {
  const axios = makeAxios()
  const logs = []
  const logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
    debug: (message) => logs.push({ level: 'debug', message })
  }
  const fsSync = require('fs')
  const fsExtra = {
    readFile: fs.readFile,
    stat: fs.stat,
    existsSync: (target) => fsSync.existsSync(target),
    readFileSync: (target, encoding) => fsSync.readFileSync(target, encoding),
    writeFileSync: (target, data, options) => fsSync.writeFileSync(target, data, options)
  }
  const fileUtils = { filePathToPOSIX: (value) => String(value).replace(/\\/g, '/') }

  const utilsDir = Path.join(__dirname, '..', '..', 'server', 'utils')
  const strmUtilsPath = Path.join(utilsDir, 'strmUtils.js')
  const strmStreamPath = Path.join(utilsDir, 'strmStream.js')

  delete require.cache[strmUtilsPath]
  delete require.cache[strmStreamPath]

  const originalLoad = Module._load
  let strmUtils
  let strmStream
  Module._load = function (request, parent, isMain) {
    if (request === 'axios') return axios
    if (request === '../Logger') return logger
    if (request === '../libs/fsExtra') return fsExtra
    if (request === './fileUtils') return fileUtils
    if (request === './strmUtils') return strmUtils
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    strmUtils = require(strmUtilsPath)
    strmStream = require(strmStreamPath)
  } finally {
    Module._load = originalLoad
  }

  return { strmUtils, strmStream, axios, logs }
}

module.exports = { loadStrmModules, makeRes, makeReq, streamOf }
