// The resume-track picker decides which track gets prewarmed when a detail page
// is opened. Warming the wrong file is why the first play still took ~15s.
const test = require('node:test')
const assert = require('node:assert')

const { loadStrmModules } = require('./helpers/strmStubs')
const { strmUtils: S } = loadStrmModules()

const files = [
  { index: 1, duration: 100 },
  { index: 2, duration: 200 },
  { index: 3, duration: 300 }
]

test('pickResumeFileIndex: 无进度时选第一轨', () => {
  assert.strictEqual(S.pickResumeFileIndex(files, 0), 0)
  assert.strictEqual(S.pickResumeFileIndex(files, -5), 0)
  assert.strictEqual(S.pickResumeFileIndex(files, NaN), 0)
})

test('pickResumeFileIndex: 按累计时长定位', () => {
  assert.strictEqual(S.pickResumeFileIndex(files, 1), 0) // 第 1 轨内
  assert.strictEqual(S.pickResumeFileIndex(files, 99.9), 0)
  assert.strictEqual(S.pickResumeFileIndex(files, 100), 1) // 正好边界 → 下一轨
  assert.strictEqual(S.pickResumeFileIndex(files, 250), 1)
  assert.strictEqual(S.pickResumeFileIndex(files, 300), 2)
  assert.strictEqual(S.pickResumeFileIndex(files, 599), 2)
})

test('pickResumeFileIndex: 超出总时长取最后一轨', () => {
  assert.strictEqual(S.pickResumeFileIndex(files, 10000), 2)
})

test('pickResumeFileIndex: 时长全未知时退回第一轨', () => {
  const unknown = [
    { index: 1, duration: 0 },
    { index: 2, duration: 0 }
  ]
  assert.strictEqual(S.pickResumeFileIndex(unknown, 500), 0)
})

test('pickResumeFileIndex: 跳过 exclude 的文件并按 index 排序', () => {
  const messy = [
    { index: 3, duration: 100 },
    { index: 1, duration: 100, exclude: true },
    { index: 2, duration: 100 }
  ]
  // 排序后 [2(100), 3(100)]；位置 150 → 第二个
  assert.strictEqual(S.pickResumeFileIndex(messy, 150), 1)
  assert.strictEqual(S.pickResumeFileIndex(messy, 10), 0)
})

test('pickResumeFileIndex: 空列表返回 -1', () => {
  assert.strictEqual(S.pickResumeFileIndex([], 10), -1)
  assert.strictEqual(S.pickResumeFileIndex(null, 10), -1)
})

test('pickResumeFileIndex: 真实场景（1500 轨，第 1080 轨）', () => {
  const many = Array.from({ length: 1500 }, (_, i) => ({ index: i + 1, duration: 600 }))
  // 572771s / 600s ≈ 954.6 → 第 955 个文件（下标 954）
  assert.strictEqual(S.pickResumeFileIndex(many, 572771), 954)
  assert.strictEqual(S.pickResumeFileIndex(many, 0), 0)
  assert.strictEqual(S.pickResumeFileIndex(many, 1499 * 600 + 1), 1499)
})
