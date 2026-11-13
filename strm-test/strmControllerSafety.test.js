// Regression guards for a bug that took the whole server down:
// routes are registered as `Controller.method.bind(this)` where `this` is the
// ApiRouter, so `this.<controller-only method>` is undefined and the async
// handler's rejection reaches Server's unhandledRejection handler, which calls
// process.exit(1) — the web client then shows "网络已断开".
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const Path = require('path')

const root = Path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(Path.join(root, rel), 'utf8')

test('LibraryItemController: 详情页预热必须是模块级函数，不能走 this', () => {
  const src = read('server/controllers/LibraryItemController.js')
  assert.match(src, /^function warmFirstTrackOnOpen\(/m, 'warmFirstTrackOnOpen 必须是模块级函数')
  assert.doesNotMatch(src, /this\.warmFirstTrackOnOpen/, 'this 是 ApiRouter，不能调用控制器私有方法')
  assert.match(src, /try\s*\{\s*\n\s*warmFirstTrackOnOpen\(req\.libraryItem\)/, '调用点必须有 try 保护')
})

test('三个入口都必须把 serveStrmStream 包在 try/catch 里', () => {
  const files = ['server/controllers/SessionController.js', 'server/controllers/LibraryItemController.js', 'server/controllers/ShareController.js']
  for (const rel of files) {
    const src = read(rel)
    assert.match(src, /try\s*\{[\s\S]{0,240}?serveStrmStream\(/, `${rel} 里的 serveStrmStream 缺少 try 包裹`)
  }
})

test('SessionController: 下一轨预热调度也必须被 try 包裹', () => {
  const src = read('server/controllers/SessionController.js')
  assert.match(src, /try\s*\{[\s\S]{0,200}?scheduleNextTrackPreload\(/, 'scheduleNextTrackPreload 缺少 try 包裹')
})

test('控制器里不出现对 ApiRouter 上不存在成员的 this 调用（白名单校验）', () => {
  // ApiRouter / PublicRouter 上真实存在的成员，允许出现在这些控制器里。
  const allowed = new Set([
    'playbackSessionManager',
    'podcastManager',
    'libraryItemController',
    'scanManager',
    'streamManager',
    'router',
    'auth'
  ])
  const files = ['server/controllers/SessionController.js', 'server/controllers/ShareController.js']
  for (const rel of files) {
    const src = read(rel)
    for (const match of src.matchAll(/\bthis\.([A-Za-z_$][\w$]*)/g)) {
      const name = match[1]
      assert.ok(allowed.has(name), `${rel} 使用了 this.${name}，但它不在路由绑定对象的成员白名单里`)
    }
  }
})
