import test from 'node:test'
import assert from 'node:assert/strict'
import { searchMemories } from '../src/search/hybrid'
import type { MemoryRecord } from '../src/types'
import { makeRecord, createMockEnv } from './helpers'

/**
 * 华东/华北场景：FTS AND 全命中记录（华北）必须排在向量分数更高的部分命中记录（华东）之前。
 */

const huabei = makeRecord({ id: 'r-huabei', content: '华北销售额 100 万' })
const huadong = makeRecord({ id: 'r-huadong', content: '华东销售额 80 万' })

test('两桶分层：FTS 全命中（华北）优先于部分命中（华东），即使向量分更低', async () => {
  const env = createMockEnv({
    // MATCH '华北* AND 销售额*' → 只有华北命中
    ftsAndRows: [{ id: 'r-huabei', snippet: '华北销售额', rank: -1.2 }],
    // MATCH '华北* OR 销售额*' → 两条都命中
    ftsOrRows: [
      { id: 'r-huabei', snippet: '华北销售额', rank: -1.2 },
      { id: 'r-huadong', snippet: '销售额', rank: -0.8 },
    ],
    records: [huabei, huadong],
    // 向量召回把华东排在前面（模拟向量分更高）
    vectorMatches: [
      { id: 'r-huadong', score: 0.95 },
      { id: 'r-huabei', score: 0.93 },
    ],
  })

  const results = await searchMemories(env, { query: '华北销售额', userId: 'u-1', topK: 5 })

  assert.equal(results.length, 2)
  assert.equal(results[0].id, 'r-huabei')
  assert.equal(results[0].bucket, 'full-match')
  assert.equal(results[1].id, 'r-huadong')
  assert.equal(results[1].bucket, 'fused')
})

test('桶内 RRF：同桶内按融合分排序', async () => {
  const a = makeRecord({ id: 'r-a', content: '华北销售额 100 万' })
  const b = makeRecord({ id: 'r-b', content: '华北销售额结构拆解' })
  const env = createMockEnv({
    ftsAndRows: [
      { id: 'r-a', rank: -1.5 },
      { id: 'r-b', rank: -1.0 },
    ],
    ftsOrRows: [],
    records: [a, b],
    // 向量把 b 排第一，RRF 后 a（FTS 第1 + 向量第2）应仍领先 b（FTS 第2 + 向量第1）
    vectorMatches: [
      { id: 'r-b', score: 0.97 },
      { id: 'r-a', score: 0.95 },
    ],
  })

  const results = await searchMemories(env, { query: '华北销售额', userId: 'u-1', topK: 5 })
  assert.equal(results[0].id, 'r-a')
  assert.equal(results[1].id, 'r-b')
})

test('分面硬过滤：只返回实体完全匹配的记录', async () => {
  const env = createMockEnv({
    ftsAndRows: [],
    ftsOrRows: [{ id: 'r-huadong', snippet: '销售额', rank: -1 }],
    records: [huabei, huadong],
    vectorMatches: [{ id: 'r-huadong', score: 0.9 }],
    entityRows: [{ memory_id: 'r-huabei', key: 'region', value: '华北' }],
  })

  const results = await searchMemories(env, {
    query: '销售额',
    userId: 'u-1',
    topK: 5,
    facets: { region: '华北' },
  })

  // 华东虽然在召回里，但缺 region=华北 分面 → 被过滤；华北通过实体表补召
  assert.equal(results.length, 1)
  assert.equal(results[0].id, 'r-huabei')
})

test('无 AI/VEC 配置时仅走 FTS', async () => {
  const env = createMockEnv({
    ftsAndRows: [{ id: 'r-huabei', rank: -1 }],
    ftsOrRows: [],
    records: [huabei],
  })
  ;(env as { AI?: unknown }).AI = undefined
  ;(env as { VEC?: unknown }).VEC = undefined

  const results = await searchMemories(env, { query: '华北销售额', userId: 'u-1', topK: 5 })
  assert.equal(results.length, 1)
  assert.equal(results[0].id, 'r-huabei')
})

test('archived 记录不会出现在搜索结果中', async () => {
  const archived = makeRecord({ id: 'r-archived', archived: 1 })
  const env = createMockEnv({
    ftsAndRows: [{ id: 'r-archived', rank: -1 }],
    ftsOrRows: [],
    records: [archived],
    vectorMatches: [{ id: 'r-archived', score: 0.9 }],
  })

  const results = await searchMemories(env, { query: '华北销售额', userId: 'u-1', topK: 5 })
  assert.equal(results.length, 0)
})

test('H3：归档记录不会占用 topK 名额', async () => {
  const archived = makeRecord({ id: 'r-archived', archived: 1, content: '华北销售额 100 万' })
  const valid = makeRecord({ id: 'r-valid', content: '华北销售额 90 万' })
  const env = createMockEnv({
    ftsAndRows: [
      { id: 'r-archived', snippet: '华北销售额', rank: -2 },
      { id: 'r-valid', snippet: '华北销售额', rank: -1 },
    ],
    ftsOrRows: [],
    records: [archived, valid],
    vectorMatches: [],
  })

  const results = await searchMemories(env, { query: '华北销售额', userId: 'u-1', topK: 1 })
  assert.equal(results.length, 1)
  assert.equal(results[0].id, 'r-valid')
})

test('H4：embedding 失败时降级为仅 FTS', async () => {
  const env = createMockEnv({
    ftsAndRows: [{ id: 'r-huabei', snippet: '华北销售额', rank: -1 }],
    ftsOrRows: [],
    records: [huabei],
    vectorMatches: [],
  })
  ;(env.AI as unknown as { run: () => Promise<never> }).run = async () => {
    throw new Error('embedding down')
  }

  const results = await searchMemories(env, { query: '华北销售额', userId: 'u-1', topK: 5 })
  assert.equal(results.length, 1)
  assert.equal(results[0].id, 'r-huabei')
})

test('H4：Vectorize 查询失败时降级为仅 FTS', async () => {
  const env = createMockEnv({
    ftsAndRows: [{ id: 'r-huabei', snippet: '华北销售额', rank: -1 }],
    ftsOrRows: [],
    records: [huabei],
    vectorMatches: [],
  })
  ;(env.VEC as unknown as { query: () => Promise<never> }).query = async () => {
    throw new Error('vectorize down')
  }

  const results = await searchMemories(env, { query: '华北销售额', userId: 'u-1', topK: 5 })
  assert.equal(results.length, 1)
  assert.equal(results[0].id, 'r-huabei')
})
