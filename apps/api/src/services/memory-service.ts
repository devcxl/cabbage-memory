import type { Env, MemoryRecord, MemoryType, WaitContext } from '../types'
import type { CreateMemoryInput, UpdateMemoryInput } from '../types'
import { DEFAULT_LIMIT, MAX_LIMIT, LLM_MODEL } from '../types'
import { segmentForIndex } from '../search/tokenizer'
import { indexMemory, deleteMemoryIndex, toIndexable } from '../search/indexing'
import { runAIWithTimeout } from '../utils/ai'
import { withRetry } from '../utils/retry'
import { fetchVectorCandidates } from '../search/hybrid'
import { userLocalDate, tzOffsetHours } from '../utils/tz'
import { ValidationError } from '../utils/errors'
import type { MemoryQueryScope } from '@devcxl/cabbage-memory-shared'
import { projectScopeCondition } from '../search/scope'

// ── subtype 校验 ──

const INSTRUCTION_SUBTYPES = ['identity', 'rule', 'workflow']
const FACT_SUBTYPES = ['preference', 'episodic', 'knowledge']

export function validateSubtype(type: MemoryType, subtype: string): string {
  if (!subtype) return ''
  if (type === 'instruction' && INSTRUCTION_SUBTYPES.includes(subtype)) return subtype
  if (type === 'fact' && FACT_SUBTYPES.includes(subtype)) return subtype
  throw new ValidationError(`Invalid subtype "${subtype}" for type "${type}"`)
}

/**
 * 统一 scope / project_id 语义：
 * - global：project_id 必须为空
 * - project：必须有 project_id
 * - 未显式指定：按 project_id 是否为空推断
 */
export function normalizeScope(
  scope: 'global' | 'project' | undefined,
  projectId: string | undefined,
): { scope: 'global' | 'project'; project_id: string } {
  const pid = (projectId || '').trim()
  if (scope === 'project') {
    if (!pid) throw new ValidationError('project scope requires project_id')
    return { scope: 'project', project_id: pid }
  }
  if (scope === 'global') return { scope: 'global', project_id: '' }
  return pid ? { scope: 'project', project_id: pid } : { scope: 'global', project_id: '' }
}

export interface CreateResult {
  id: string
}

/**
 * 创建记忆。同步路径只有 D1 插入（~5ms）；
 * 向量索引与 fact 理解性后处理均通过 waitUntil 异步执行。
 */
export async function createMemory(
  env: Env,
  userId: string,
  input: CreateMemoryInput,
  executionCtx?: WaitContext,
): Promise<CreateResult> {
  if (input.type === 'digest') {
    throw new ValidationError('digest type is system-generated')
  }
  const id = crypto.randomUUID()
  const now = Date.now()
  const subtype = validateSubtype(input.type, input.subtype || '')
  const normalized = normalizeScope(input.scope, input.project_id)
  const date = input.date || (input.type === 'daily'
    ? userLocalDate(now, tzOffsetHours(env))
    : '')

  await env.DB.prepare(
    `INSERT INTO memories (id, user_id, type, subtype, title, content, content_fts, scope, project_id, date, tags, source, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      userId,
      input.type,
      subtype,
      input.title || '',
      input.content,
      segmentForIndex(`${input.title || ''} ${input.content}`),
      normalized.scope,
      normalized.project_id,
      date,
      JSON.stringify(input.tags || []),
      'agent',
      '{}',
      now,
    )
    .run()

  const asyncWork: Promise<unknown>[] = [
    indexMemory(
      { env, runAIWithTimeout, withRetry },
      {
        id,
        user_id: userId,
        type: input.type,
        subtype,
        title: input.title || '',
        content: input.content,
        project_id: input.project_id || '',
        date,
        created_at: now,
      },
    ),
  ]
  if (input.type === 'fact' && env.AI) {
    asyncWork.push(postProcessFact(env, userId, id, input.content).catch((e) => {
      console.error('[fact-postprocess] failed:', e instanceof Error ? e.message : e)
    }))
  }
  if (executionCtx) executionCtx.waitUntil(Promise.all(asyncWork))

  return { id }
}

export interface ListOptions {
  type?: MemoryType
  subtype?: string
  scope?: MemoryQueryScope
  project_id?: string
  date?: string
  limit?: number
  offset?: number
}

export async function listMemories(env: Env, userId: string, opts: ListOptions = {}): Promise<MemoryRecord[]> {
  const { type, subtype, scope, project_id, date, limit = DEFAULT_LIMIT, offset = 0 } = opts

  const conditions: string[] = ['user_id = ?', 'archived = 0']
  const bindings: unknown[] = [userId]
  if (type) {
    conditions.push('type = ?')
    bindings.push(type)
  }
  if (subtype) {
    conditions.push('subtype = ?')
    bindings.push(subtype)
  }
  const scopeCond = projectScopeCondition(scope, project_id)
  if (scopeCond.sql) {
    conditions.push(scopeCond.sql.slice(' AND '.length))
    bindings.push(...scopeCond.bindings)
  }
  if (date) {
    conditions.push('date = ?')
    bindings.push(date)
  }

  bindings.push(Math.min(limit, MAX_LIMIT), offset)
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, type, subtype, title, content, scope, project_id, date, tags, source, source_ids, meta,
            created_at, updated_at, digested_at, archived
     FROM memories WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...bindings)
    .all<MemoryRecord>()
  return results || []
}

export async function getMemory(env: Env, userId: string, id: string): Promise<MemoryRecord | null> {
  const row = await env.DB.prepare(
    `SELECT id, user_id, type, subtype, title, content, scope, project_id, date, tags, source, source_ids, meta,
            created_at, updated_at, digested_at, archived
     FROM memories WHERE id = ? AND user_id = ? AND archived = 0`,
  )
    .bind(id, userId)
    .first<MemoryRecord>()
  return row ?? null
}

export async function updateMemory(
  env: Env,
  userId: string,
  id: string,
  input: UpdateMemoryInput,
  executionCtx?: WaitContext,
): Promise<void> {
  const existing = await getMemory(env, userId, id)
  if (!existing) throw new Error('Memory not found')

  const title = input.title ?? existing.title
  const content = input.content ?? existing.content
  const tags = input.tags ? JSON.stringify(input.tags) : existing.tags
  const projectId = input.project_id !== undefined ? input.project_id : existing.project_id
  const normalized = normalizeScope(undefined, projectId)

  await env.DB.prepare(
    `UPDATE memories SET title = ?, content = ?, content_fts = ?, tags = ?, project_id = ?, scope = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  )
    .bind(
      title,
      content,
      segmentForIndex(`${title} ${content}`),
      tags,
      normalized.project_id,
      normalized.scope,
      Date.now(),
      id,
      userId,
    )
    .run()

  if (executionCtx) {
    executionCtx.waitUntil(
      indexMemory({ env, runAIWithTimeout, withRetry }, {
        id,
        user_id: userId,
        type: existing.type,
        subtype: existing.subtype,
        title,
        content,
        project_id: normalized.project_id,
        date: existing.date,
        created_at: existing.created_at,
      }),
    )
  }
}

/** 删除（硬删）：同时清理向量索引、实体、关系链 */
export async function deleteMemory(env: Env, userId: string, id: string): Promise<void> {
  const result = await env.DB.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .run()
  if ((result.meta?.changes ?? 0) === 0) throw new Error('Memory not found')

  await env.DB.prepare('DELETE FROM memory_entities WHERE memory_id = ?').bind(id).run()
  await env.DB.prepare('DELETE FROM memory_links WHERE from_id = ? OR to_id = ?').bind(id, id).run()
  await deleteMemoryIndex(env, id)
}

// ── fact 写入后处理：实体抽取 + 查重 + 新陈代谢（一次 LLM 调用） ──

interface FactPostProcessResult {
  duplicate_of?: string | null
  supersedes?: string[]
  contradicts?: string[]
  entities?: Array<{ key: string; value: string }>
}

export async function postProcessFact(env: Env, userId: string, id: string, content: string): Promise<void> {
  // 向量预召回相关旧事实，给 LLM 做矛盾/重复判断的上下文
  const related = await fetchVectorCandidates(env, { query: content, userId, type: 'fact', topK: 5 })
  const relatedContext = related
    .filter((r) => r.id !== id)
    .map((r) => `{"id": "${r.id}", "content": ${JSON.stringify(r.content.slice(0, 300))}}`)
    .join(',\n')

  const response = await runAIWithTimeout(env.AI, LLM_MODEL, {
    messages: [
      {
        role: 'system',
        content: `你负责维护记忆库的一致性。对比新事实与近期旧事实，输出 JSON（不要额外文字）：
{
  "duplicate_of": "与旧事实语义重复时填该旧事实 id，否则为 null",
  "supersedes": ["因新事实而失效（被推翻/更新）的旧事实 id"],
  "contradicts": ["与新事实矛盾但不确定是否推翻的旧事实 id"],
  "entities": [{"key": "region|tech|person|version|topic", "value": "具体值"}]
}
规则：
- entities 抽取新事实中区分度高的可过滤维度（如地区、技术栈、人名），没有则为空数组
- supersedes 仅当旧事实确实被新事实取代（如端口变更、方案更替）
- 不确定时宁可放入 contradicts 而不是 supersedes
/no_think`,
      },
      {
        role: 'user',
        content: `新事实：\n${content}\n\n近期旧事实：\n[${relatedContext}]`,
      },
    ],
    max_tokens: 1024,
    temperature: 0.1,
    response_format: {
      type: 'json_schema',
      json_schema: {
        type: 'object',
        properties: {
          duplicate_of: { type: ['string', 'null'] },
          supersedes: { type: 'array', items: { type: 'string' } },
          contradicts: { type: 'array', items: { type: 'string' } },
          entities: {
            type: 'array',
            items: {
              type: 'object',
              properties: { key: { type: 'string' }, value: { type: 'string' } },
              required: ['key', 'value'],
              additionalProperties: false,
            },
          },
        },
        required: ['duplicate_of', 'supersedes', 'contradicts', 'entities'],
        additionalProperties: false,
      },
    },
  })

  const parsed = extractJson<FactPostProcessResult>(response)
  if (!parsed) return

  // LLM 输出只能操作本次向量召回候选集内的 fact；禁止自指、跨类型或任意 id。
  const relatedIds = new Set(related.map((r) => r.id).filter((rid) => rid !== id))
  const duplicateOf =
    typeof parsed.duplicate_of === 'string' && relatedIds.has(parsed.duplicate_of)
      ? parsed.duplicate_of
      : null
  const supersedes = [...new Set(parsed.supersedes || [])].filter((oldId) => relatedIds.has(oldId))
  const contradicts = [...new Set(parsed.contradicts || [])].filter((oldId) => relatedIds.has(oldId))

  const statements: Array<ReturnType<Env['DB']['prepare']>> = []
  const link = (toId: string, relation: string) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO memory_links (from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?)',
    ).bind(id, toId, relation, Date.now())

  if (duplicateOf) {
    // 重复事实：保留 derived_from 追溯链，归档新事实，不写实体
    statements.push(link(duplicateOf, 'derived_from'))
    statements.push(
      env.DB.prepare('UPDATE memories SET archived = 1 WHERE id = ? AND user_id = ? AND type = ?')
        .bind(id, userId, 'fact'),
    )
    await env.DB.batch(statements)
    await deleteMemoryIndex(env, id)
    return
  }

  for (const oldId of supersedes) {
    statements.push(link(oldId, 'supersedes'))
    statements.push(
      env.DB.prepare(
        'UPDATE memories SET archived = 1 WHERE id = ? AND user_id = ? AND type = ? AND id != ?',
      ).bind(oldId, userId, 'fact', id),
    )
  }
  for (const oldId of contradicts) {
    statements.push(link(oldId, 'contradicts'))
  }
  if (parsed.entities?.length) {
    statements.push(env.DB.prepare('DELETE FROM memory_entities WHERE memory_id = ?').bind(id))
    for (const e of parsed.entities) {
      if (!e.key || !e.value) continue
      statements.push(
        env.DB.prepare(
          'INSERT OR IGNORE INTO memory_entities (memory_id, user_id, key, value) VALUES (?, ?, ?, ?)',
        ).bind(id, userId, e.key.trim().toLowerCase(), e.value.trim()),
      )
    }
  }
  if (statements.length > 0) await env.DB.batch(statements)
  for (const oldId of supersedes) await deleteMemoryIndex(env, oldId)
}

export async function setMemoryEntities(
  env: Env,
  userId: string,
  memoryId: string,
  entities: Array<{ key: string; value: string }>,
): Promise<void> {
  await env.DB.prepare('DELETE FROM memory_entities WHERE memory_id = ?').bind(memoryId).run()
  for (const e of entities) {
    if (!e.key || !e.value) continue
    await env.DB.prepare(
      'INSERT OR IGNORE INTO memory_entities (memory_id, user_id, key, value) VALUES (?, ?, ?, ?)',
    )
      .bind(memoryId, userId, e.key.trim().toLowerCase(), e.value.trim())
      .run()
  }
}

/** 从 LLM 响应中提取 JSON（兼容裸 JSON 与 ```json 包裹） */
function extractJson<T>(response: unknown): T | null {
  const raw =
    typeof response === 'string'
      ? response
      : ((response as { response?: string })?.response ??
        (response as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ??
        '')
  if (!raw) return null
  const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '')
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0]) as T
  } catch {
    return null
  }
}

// 供类型复用（indexing 的 deps 构造在服务层统一走这里）
export function indexingDeps(env: Env) {
  return { env, runAIWithTimeout, withRetry }
}

export function memoryToIndexable(row: MemoryRecord) {
  return toIndexable(row)
}
