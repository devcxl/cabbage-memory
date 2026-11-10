import type { Env, MemoryRecord, MemoryType, SearchResult } from '../types'
import type { MemoryQueryScope } from '@devcxl/cabbage-memory-shared'
import { MAX_VECTOR_TOP_K } from '../types'
import { preprocessQuery, buildFtsMatchExpression, type ProcessedQuery } from './tokenizer'
import { runAIWithTimeout } from '../utils/ai'
import { EMBEDDING_MODEL } from '../types'
import { projectFilterValues, projectScopeCondition } from './scope'

/**
 * 两桶分层混合搜索：
 * 1. FTS AND 全命中的记录进入桶 A（full-match）——"华北销售额" 命中 {华北,销售额}，
 *    而 "华东销售额" 只命中 {销售额}，只能进桶 B，向量分再高也排不到前面
 * 2. 其余候选（FTS OR 部分命中 + 向量召回）进入桶 B（fused）
 * 3. 桶内 RRF 融合（FTS 排名 + 向量排名），桶 A 永远整体排在桶 B 之前
 * 4. 可选：分面（entities）硬过滤——候选池并入实体命中记录，最终只保留全部分面匹配的结果
 */

const RRF_K = 60

interface SearchOptions {
  query: string
  userId: string
  topK?: number
  type?: MemoryType
  scope?: MemoryQueryScope
  projectId?: string
  facets?: Record<string, string>
}

interface FtsRow {
  id: string
  snippet: string
  rank: number
}

interface Candidate {
  id: string
  bucket: 'full-match' | 'fused'
  score: number
  snippet: string
}

export async function searchMemories(env: Env, opts: SearchOptions): Promise<SearchResult[]> {
  const { query, userId, type, scope, projectId, facets } = opts
  const topK = Math.min(Math.max(opts.topK ?? 8, 1), MAX_VECTOR_TOP_K)

  const processed = preprocessQuery(query)
  const hasFts = processed.tokens.length > 0

  // 并行：FTS AND（桶 A）+ FTS OR（桶 B 候选）+ 向量召回
  const [andRows, orRows, vecIds] = await Promise.all([
    hasFts
      ? ftsQuery(env, { processed, userId, type, scope, projectId, mode: 'AND', limit: topK * 3 })
      : [],
    hasFts
      ? ftsQuery(env, { processed, userId, type, scope, projectId, mode: 'OR', limit: topK * 4 })
      : [],
    vectorCandidateIds(env, { query, userId, type, scope, projectId, topK }),
  ])

  const andIds = new Set(andRows.map((r) => r.id))
  const vecIdSet = new Set(vecIds)

  // 桶 A：AND 全命中；桶 B：OR 部分命中（去掉 A）+ 向量召回（去掉 A）
  const listA_f = andRows.map((r) => r.id)
  const listB_f = orRows.filter((r) => !andIds.has(r.id)).map((r) => r.id)
  const listA_v = vecIds.filter((id) => andIds.has(id))
  const listB_v = vecIds.filter((id) => !andIds.has(id))

  const scoreA = rrf(listA_f, listA_v)
  const scoreB = rrf(listB_f, listB_v)

  const candidates: Candidate[] = []
  for (const row of andRows) {
    candidates.push({ id: row.id, bucket: 'full-match', score: scoreA.get(row.id) || 0, snippet: row.snippet })
  }
  const orSnippet = new Map(orRows.map((r) => [r.id, r.snippet]))
  for (const id of new Set([...listB_f, ...listB_v])) {
    candidates.push({
      id,
      bucket: 'fused',
      score: scoreB.get(id) || 0,
      snippet: orSnippet.get(id) || '',
    })
  }

  // 分面硬过滤：实体命中记录并入候选池（防止漏召），最终只保留全部分面匹配的记录
  let allowedIds: Set<string> | null = null
  let allowedExtra: string[] = []
  if (facets && Object.keys(facets).length > 0) {
    allowedIds = await filterIdsByFacets(env, userId, facets, scope, projectId)
    allowedExtra = [...allowedIds].filter((id) => !candidates.some((c) => c.id === id))
    for (const id of allowedExtra) {
      candidates.push({ id, bucket: 'fused', score: 0, snippet: '' })
    }
  }

  // 先按分面硬过滤（在截断前执行，防止有效候选被挤出 topK）
  let eligibleCandidates = candidates
  if (allowedIds) {
    eligibleCandidates = candidates.filter((c) => allowedIds.has(c.id))
  }

  // 排序：桶 A 整体在前，桶内按 RRF 分数
  eligibleCandidates.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket === 'full-match' ? -1 : 1
    if (b.score !== a.score) return b.score - a.score
    return 0
  })
  const topCandidates = eligibleCandidates.slice(0, topK)

  const records = await hydrate(env, userId, topCandidates.map((c) => c.id), scope, projectId)
  const recordMap = new Map(records.map((r) => [r.id, r]))

  const results: SearchResult[] = []
  for (const c of topCandidates) {
    const record = recordMap.get(c.id)
    if (!record) continue
    results.push(toSearchResult(record, c))
  }
  return results
}

// ── FTS 查询 ──

async function ftsQuery(
  env: Env,
  args: {
    processed: ProcessedQuery
    userId: string
    type?: MemoryType
    scope?: MemoryQueryScope
    projectId?: string
    mode: 'AND' | 'OR'
    limit: number
  },
): Promise<FtsRow[]> {
  const matchExpr = buildFtsMatchExpression(args.processed.tokens, args.mode)
  if (!matchExpr) return []

  const bindings: Array<string | number> = [matchExpr, args.userId]
  let sql = `SELECT id, snippet(memories_fts, 0, '<b>', '</b>', '...', 40) AS snippet, bm25(memories_fts) AS rank
             FROM memories_fts WHERE memories_fts MATCH ? AND user_id = ?`
  // 过滤必须在 LIMIT 之前完成：归档记录不能占用 topK 名额
  sql += ' AND id IN (SELECT id FROM memories WHERE user_id = ? AND archived = 0'
  bindings.push(args.userId)
  if (args.type) {
    sql += ' AND type = ?'
    bindings.push(args.type)
  }
  const scopeCond = projectScopeCondition(args.scope, args.projectId)
  sql += scopeCond.sql
  bindings.push(...scopeCond.bindings)
  sql += ')'
  sql += ' ORDER BY rank ASC LIMIT ?'
  bindings.push(args.limit)

  try {
    const { results } = await env.DB.prepare(sql).bind(...bindings).all<FtsRow>()
    return results || []
  } catch (error) {
    console.error('[fts] query failed:', error instanceof Error ? error.message : error)
    return []
  }
}

// ── 向量召回 ──

interface VectorMatch {
  id: string
  score?: number
}

export async function vectorCandidateIds(
  env: Env,
  args: {
    query: string
    userId: string
    type?: MemoryType
    scope?: MemoryQueryScope
    projectId?: string
    topK: number
  },
): Promise<string[]> {
  if (!env.AI || !env.VEC) return []
  const ai = env.AI
  const vec = env.VEC

  try {
    const embedding = await runAIWithTimeout<{ data: number[][] }>(ai, EMBEDDING_MODEL, {
      text: args.query,
    })

    const baseFilter: Record<string, string> = { user_id: args.userId }
    if (args.type) baseFilter.type = args.type

    // project scope 需要同时召回当前项目和全局记忆；Vectorize 不支持 OR，分两次查后合并。
    const projectValues = projectFilterValues(args.scope, args.projectId)
    const filters =
      projectValues.length > 0
        ? projectValues.map((value) => ({ ...baseFilter, project_id: value }))
        : [baseFilter]

    const settled = await Promise.allSettled(
      filters.map((filter) =>
        vec.query(embedding.data[0], {
          topK: Math.min(args.topK, MAX_VECTOR_TOP_K),
          filter,
          returnMetadata: 'none',
        }),
      ),
    )

    const ids: string[] = []
    const seen = new Set<string>()
    for (const result of settled) {
      if (result.status === 'rejected') {
        console.error(
          '[vector] query failed:',
          result.reason instanceof Error ? result.reason.message : result.reason,
        )
        continue
      }
      for (const match of (result.value.matches || []) as VectorMatch[]) {
        if (seen.has(match.id)) continue
        seen.add(match.id)
        ids.push(match.id)
      }
    }
    return ids.slice(0, args.topK)
  } catch (error) {
    console.error('[vector] query failed:', error instanceof Error ? error.message : error)
    return []
  }
}

/** 仅向量召回的候选记录（fact 后处理查重/矛盾检测用） */
export async function fetchVectorCandidates(
  env: Env,
  args: { query: string; userId: string; type?: MemoryType; topK: number },
): Promise<Array<Pick<MemoryRecord, 'id' | 'title' | 'content'>>> {
  if (!env.AI || !env.VEC) return []
  try {
    const ids = await vectorCandidateIds(env, { ...args, projectId: undefined })
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const { results } = await env.DB.prepare(
      `SELECT id, title, content FROM memories
       WHERE id IN (${placeholders}) AND user_id = ? AND archived = 0 AND type = 'fact'`,
    )
      .bind(...ids, args.userId)
      .all<Pick<MemoryRecord, 'id' | 'title' | 'content'>>()
    return results || []
  } catch (error) {
    console.error('[vector] candidate fetch failed:', error instanceof Error ? error.message : error)
    return []
  }
}

// ── 分面过滤 ──

/** 返回同时匹配全部分面的记忆 id 集合 */
async function filterIdsByFacets(
  env: Env,
  userId: string,
  facets: Record<string, string>,
  scope?: MemoryQueryScope,
  projectId?: string,
): Promise<Set<string>> {
  const entries = Object.entries(facets).filter(([k, v]) => k && v)
  if (entries.length === 0) return new Set()

  const keyConditions = entries.map(() => '(e.key = ? AND e.value = ?)').join(' OR ')
  const bindings: string[] = [userId]
  for (const [k, v] of entries) {
    bindings.push(k.trim().toLowerCase(), v.trim())
  }
  const scopeCond = projectScopeCondition(scope, projectId, 'm.project_id')

  const { results } = await env.DB.prepare(
    `SELECT e.memory_id, e.key, e.value FROM memory_entities e
     JOIN memories m ON m.id = e.memory_id AND m.user_id = e.user_id
     WHERE e.user_id = ? AND m.archived = 0 AND (${keyConditions})${scopeCond.sql}`,
  )
    .bind(...bindings, ...scopeCond.bindings)
    .all<{ memory_id: string; key: string; value: string }>()

  // 按 memory_id 分组，校验每个分面都有命中
  const hits = new Map<string, Set<string>>()
  for (const row of results || []) {
    if (!hits.has(row.memory_id)) hits.set(row.memory_id, new Set())
    hits.get(row.memory_id)!.add(`${row.key}=${row.value}`)
  }

  const allowed = new Set<string>()
  for (const [memoryId, pairs] of hits) {
    if (entries.every(([k, v]) => pairs.has(`${k.trim().toLowerCase()}=${v.trim()}`))) {
      allowed.add(memoryId)
    }
  }
  return allowed
}

// ── RRF 与组装 ──

function rrf(...rankedLists: string[][]): Map<string, number> {
  const scores = new Map<string, number>()
  for (const list of rankedLists) {
    for (let i = 0; i < list.length; i++) {
      scores.set(list[i], (scores.get(list[i]) || 0) + 1 / (RRF_K + i + 1))
    }
  }
  return scores
}

async function hydrate(
  env: Env,
  userId: string,
  ids: string[],
  scope?: MemoryQueryScope,
  projectId?: string,
): Promise<MemoryRecord[]> {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const scopeCond = projectScopeCondition(scope, projectId)
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, type, subtype, title, content, scope, project_id, date, tags, source, source_ids, meta,
            created_at, updated_at, digested_at, archived
     FROM memories
     WHERE id IN (${placeholders}) AND user_id = ? AND archived = 0${scopeCond.sql}`,
  )
    .bind(...ids, userId, ...scopeCond.bindings)
    .all<MemoryRecord>()
  return results || []
}

function toSearchResult(record: MemoryRecord, candidate: Candidate): SearchResult {
  return {
    id: record.id,
    type: record.type,
    subtype: record.subtype,
    title: record.title,
    content: record.content,
    tags: record.tags,
    project_id: record.project_id,
    date: record.date,
    created_at: record.created_at,
    bucket: candidate.bucket,
    score: candidate.score,
    snippet: candidate.snippet,
  }
}
