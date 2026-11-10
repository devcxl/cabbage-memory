import type { Env, MemoryRecord } from '../types'
import { EMBEDDING_MODEL, MAX_VECTOR_TOP_K } from '../types'
import { runAIWithTimeout } from '../utils/ai'
import { withRetry } from '../utils/retry'
import { segmentForIndex } from './tokenizer'

interface EmbeddingResponse {
  data: number[][]
}

/** 可索引的记忆条目 */
export interface IndexableMemory {
  id: string
  user_id: string
  type: string
  subtype: string
  title: string
  content: string
  project_id: string
  date: string
  created_at: number
}

export interface IndexingDeps {
  env: Env
  runAIWithTimeout: typeof runAIWithTimeout
  withRetry: typeof withRetry
}

export function indexText(item: Pick<IndexableMemory, 'title' | 'content'>): string {
  return item.title ? `${item.title}\n${item.content}` : item.content
}

function vectorMetadata(item: IndexableMemory): Record<string, string | number> {
  return {
    user_id: item.user_id,
    type: item.type,
    subtype: item.subtype,
    project_id: item.project_id,
    date: item.date,
    created_at: item.created_at,
    // 记录 embedding 模型版本，换模型后 /api/reindex 可增量重建
    model: EMBEDDING_MODEL,
  }
}

async function embed(deps: IndexingDeps, texts: string[]): Promise<number[][]> {
  const response = await runAIWithTimeout<EmbeddingResponse>(
    deps.env.AI,
    EMBEDDING_MODEL,
    { text: texts },
  )
  if (!response?.data || response.data.length !== texts.length) {
    throw new Error('Embedding response shape mismatch')
  }
  return response.data
}

/** 批量写入向量（Workers AI 支持批量 embedding；失败抛出，由调用方决定是否吞掉） */
export async function indexMemories(deps: IndexingDeps, items: IndexableMemory[]): Promise<void> {
  const { env, withRetry } = deps
  if (!env.AI || !env.VEC || items.length === 0) return

  // Vectorize 单次 upsert 上限 50，按批切分
  const batchSize = MAX_VECTOR_TOP_K
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const vectors = await embed(deps, batch.map(indexText))
    await withRetry(
      () =>
        env.VEC.upsert(
          batch.map((item, j) => ({
            id: item.id,
            values: vectors[j],
            metadata: vectorMetadata(item),
          })),
        ),
      'memory vector upsert',
    )
  }
}

/** 单条写入（write 路径 waitUntil 调用；失败仅打日志，不影响主流程） */
export async function indexMemory(deps: IndexingDeps, item: IndexableMemory): Promise<void> {
  try {
    await indexMemories(deps, [item])
  } catch (error) {
    console.error(`[index] failed for ${item.id}:`, error instanceof Error ? error.message : error)
  }
}

export async function deleteMemoryIndex(env: Env, id: string): Promise<void> {
  if (!env.VEC) return
  try {
    await env.VEC.deleteByIds([id])
  } catch (error) {
    console.error(`[index] delete failed for ${id}:`, error instanceof Error ? error.message : error)
  }
}

/** D1 记录 → 可索引条目 */
export function toIndexable(row: MemoryRecord): IndexableMemory {
  return {
    id: row.id,
    user_id: row.user_id,
    type: row.type,
    subtype: row.subtype,
    title: row.title,
    content: row.content,
    project_id: row.project_id,
    date: row.date,
    created_at: row.created_at,
  }
}

/**
 * 全量/分批重建向量索引（/api/reindex 与迁移脚本共用）。
 * 跳过 model 已是当前版本的记录，实现模型换版后的增量重建；
 * 支持 limit 与 offset 分批处理，防止数据量大时单个 Worker 请求超时。
 */
export async function reindexAll(
  env: Env,
  userId: string,
  opts: { force?: boolean; limit?: number; offset?: number } = {},
): Promise<{
  total: number
  indexed: number
  skipped: number
  failed: number
  ftsUpdated: number
  hasMore: boolean
  nextOffset?: number
}> {
  let total = 0
  let indexed = 0
  let skipped = 0
  let failed = 0
  let ftsUpdated = 0

  let currentOffset = opts.offset ?? 0
  const maxLimit = opts.limit
  const pageSize = maxLimit ? Math.min(maxLimit, 100) : 100
  let hasMore = false

  for (;;) {
    const fetchLimit = maxLimit ? Math.min(pageSize, maxLimit - total) : pageSize
    if (fetchLimit <= 0) {
      const checkNext = await env.DB.prepare(
        'SELECT 1 FROM memories WHERE user_id = ? AND archived = 0 ORDER BY created_at ASC LIMIT 1 OFFSET ?',
      )
        .bind(userId, currentOffset)
        .first()
      hasMore = Boolean(checkNext)
      break
    }

    const { results } = await env.DB.prepare(
      'SELECT * FROM memories WHERE user_id = ? AND archived = 0 ORDER BY created_at ASC LIMIT ? OFFSET ?',
    )
      .bind(userId, fetchLimit, currentOffset)
      .all<MemoryRecord>()

    const rows = results || []
    if (rows.length === 0) break

    // H1：迁移会把 instructions 的 content_fts 留空（旧分词器产出的 daily/learning 也可能过期）。
    // reindex 不能只重建向量，必须同步重算 FTS，否则这些记录永远无法被关键词检索命中。
    const ftsStatements: Array<ReturnType<Env['DB']['prepare']>> = []
    for (const row of rows) {
      const contentFts = segmentForIndex(`${row.title || ''} ${row.content}`)
      if (contentFts === (row.content_fts || '')) continue
      ftsStatements.push(
        env.DB.prepare('UPDATE memories SET content_fts = ? WHERE id = ? AND user_id = ?').bind(
          contentFts,
          row.id,
          userId,
        ),
      )
    }
    if (ftsStatements.length > 0) {
      await env.DB.batch(ftsStatements)
      ftsUpdated += ftsStatements.length
    }

    const pending: MemoryRecord[] = opts.force
      ? rows
      : rows.filter((r) => {
          try {
            const meta = JSON.parse(r.meta || '{}') as { vector_model?: string }
            return meta.vector_model !== EMBEDDING_MODEL
          } catch {
            return true
          }
        })

    try {
      await indexMemories({ env, runAIWithTimeout, withRetry }, pending.map(toIndexable))
      indexed += pending.length
      skipped += rows.length - pending.length
      // 回写模型版本标记
      if (pending.length > 0) {
        const ids = pending.map((r) => r.id)
        const placeholders = ids.map(() => '?').join(',')
        await env.DB.prepare(
          `UPDATE memories SET meta = json_set(COALESCE(meta, '{}'), '$.vector_model', ?) WHERE id IN (${placeholders})`,
        )
          .bind(EMBEDDING_MODEL, ...ids)
          .run()
      }
    } catch (error) {
      failed += pending.length
      console.error('[reindex] batch failed:', error instanceof Error ? error.message : error)
    }
    total += rows.length
    currentOffset += rows.length
    if (rows.length < fetchLimit) break
  }

  return { total, indexed, skipped, failed, ftsUpdated, hasMore, nextOffset: hasMore ? currentOffset : undefined }
}
