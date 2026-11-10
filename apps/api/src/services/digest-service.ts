import type { Env, WaitContext, MemoryRecord, JobRun } from '../types'
import { LLM_MODEL } from '../types'
import { runAIWithTimeout } from '../utils/ai'
import { withRetry } from '../utils/retry'
import { indexMemory } from '../search/indexing'
import { segmentForIndex } from '../search/tokenizer'
import { setMemoryEntities } from './memory-service'
import { tzOffsetHours, userYesterday } from '../utils/tz'

/**
 * 每日 04:00（用户时区）digest：把"昨天"的 daily 流水总结成一条事实记忆。
 * 幂等策略：digest 占位行（唯一索引 user+project+date 兜底）先占位再生成，
 * 生成失败时占位行保留（content 为空），下次 cron 优先重试未完成的占位。
 */

const DIGEST_PLACEHOLDER_TITLE = '__digest_pending__'
/** 单次 cron 最多补扫的 user×project×date 分组数，避免一次请求超时 */
export const DIGEST_BACKFILL_LIMIT = 20
/** 单次 cron 最多重试的未完成 digest 占位数 */
export const DIGEST_PENDING_LIMIT = 20
/** 同一占位连续失败多少次后归档，避免永久重试 */
export const DIGEST_MAX_ATTEMPTS = 5

interface DigestSummary {
  title: string
  content: string
  tags: string[]
  entities: Array<{ key: string; value: string }>
}

export async function runDailyDigest(
  env: Env,
  ctx?: WaitContext,
  targetDate?: string,
): Promise<{ processed: number; failed: number }> {
  const offset = tzOffsetHours(env)
  const runDate = targetDate || userYesterday(offset)
  let processed = 0
  let failed = 0
  const jobId = await startJob(env, 'digest')

  try {
    // 1. 重试：上一次未完成的 digest 占位（content 仍为空）
    const pending = await env.DB.prepare(
      `SELECT user_id, project_id, date FROM memories
       WHERE type = 'digest' AND content = '' AND archived = 0
       ORDER BY created_at ASC LIMIT ?`,
    )
      .bind(DIGEST_PENDING_LIMIT)
      .all<{ user_id: string; project_id: string; date: string }>()
    for (const row of pending.results || []) {
      try {
        if (await digestOneGroup(env, row.user_id, row.project_id, row.date, ctx)) processed++
      } catch (error) {
        failed++
        console.error('[digest] pending failed:', error instanceof Error ? error.message : error)
        await recordDigestFailure(env, row, error)
      }
    }

    // 2. 补扫所有漏跑的日期（含昨天），按日期从旧到新，单次最多 DIGEST_BACKFILL_LIMIT 组。
    // 手动指定 targetDate 时只处理该日期，避免误补其他日期。
    const groups = targetDate
      ? await env.DB.prepare(
          `SELECT user_id, project_id, date FROM memories
           WHERE type = 'daily' AND date = ? AND digested_at IS NULL AND archived = 0
           GROUP BY user_id, project_id, date
           ORDER BY user_id, project_id`,
        )
          .bind(targetDate)
          .all<{ user_id: string; project_id: string; date: string }>()
      : await env.DB.prepare(
          `SELECT user_id, project_id, date FROM memories
           WHERE type = 'daily' AND date <= ? AND digested_at IS NULL AND archived = 0
           GROUP BY user_id, project_id, date
           ORDER BY date ASC, user_id, project_id
           LIMIT ?`,
        )
          .bind(runDate, DIGEST_BACKFILL_LIMIT)
          .all<{ user_id: string; project_id: string; date: string }>()

    for (const group of groups.results || []) {
      try {
        // false = 占位已被并发执行处理，视为跳过而非失败
        if (await digestOneGroup(env, group.user_id, group.project_id, group.date, ctx)) processed++
      } catch (error) {
        failed++
        console.error('[digest] group failed:', error instanceof Error ? error.message : error)
        await recordDigestFailure(env, group, error)
      }
    }

    await finishJob(env, jobId, 'completed', {
      processed,
      failed,
      through: runDate,
      backfillLimit: targetDate ? undefined : DIGEST_BACKFILL_LIMIT,
    })
    return { processed, failed }
  } catch (error) {
    await finishJob(env, jobId, 'failed', { error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

/** 对单个 user×project×date 执行 digest。返回 true 表示完成，false 表示无待处理数据 */
export async function digestOneGroup(
  env: Env,
  userId: string,
  projectId: string,
  date: string,
  ctx?: WaitContext,
): Promise<boolean> {
  // 1. 取未消费的 daily 原文
  const { results: dailies } = await env.DB.prepare(
    `SELECT id, content FROM memories
     WHERE type = 'daily' AND user_id = ? AND project_id = ? AND date = ?
       AND digested_at IS NULL AND archived = 0
     ORDER BY created_at ASC`,
  )
    .bind(userId, projectId, date)
    .all<Pick<MemoryRecord, 'id' | 'content'>>()
  if (!dailies || dailies.length === 0) {
    // 若此前已有未完成的占位行（content 为空），但当前已无待处理 daily（已被删除或已归档），
    // 主动归档该无效占位，避免 cron 每天无限次重试此残留占位
    await env.DB.prepare(
      `UPDATE memories SET archived = 1
       WHERE type = 'digest' AND user_id = ? AND project_id = ? AND date = ? AND content = '' AND archived = 0`,
    )
      .bind(userId, projectId, date)
      .run()
      .catch(() => undefined)
    return false
  }

  // 2. 占位/版本：占位行（content=''）复用；已完成的 digest 保留历史，
  //    新建 active 版本并把旧行归档，source_ids 取并集，避免整条 UPDATE 覆盖旧摘要。
  type DigestRow = { id: string; content: string; source_ids: string | null }
  const selectExisting = () =>
    env.DB.prepare(
      `SELECT id, content, source_ids FROM memories
       WHERE type = 'digest' AND user_id = ? AND project_id = ? AND date = ? AND archived = 0`,
    )
      .bind(userId, projectId, date)
      .first<DigestRow>()

  let existing = await selectExisting()
  if (!existing) {
    // 已达失败上限的归档占位存在时不再重建，避免「归档 -> 补扫重建 -> 再次失败」无限循环
    const exhausted = await env.DB.prepare(
      `SELECT id FROM memories
       WHERE type = 'digest' AND user_id = ? AND project_id = ? AND date = ?
         AND archived = 1 AND content = ''
         AND COALESCE(json_extract(meta, '$.digest_attempts'), 0) >= ?
       LIMIT 1`,
    )
      .bind(userId, projectId, date, DIGEST_MAX_ATTEMPTS)
      .first<{ id: string }>()
    if (exhausted) return false

    await env.DB.prepare(
      `INSERT OR IGNORE INTO memories (id, user_id, type, subtype, title, content, scope, project_id, date, tags, source, meta, created_at)
       VALUES (?, ?, 'digest', '', ?, '', ?, ?, ?, '[]', 'digest', '{}', ?)`,
    )
      .bind(crypto.randomUUID(), userId, DIGEST_PLACEHOLDER_TITLE, projectId ? 'project' : 'global', projectId, date, Date.now())
      .run()
    // 冲突（并发占位/并发完成）时重查；若已有正式摘要，走版本化分支
    existing = await selectExisting()
    if (!existing) return false
  }

  let digestId: string
  let previousSourceIds: string[] = []

  if (existing.content === '') {
    digestId = existing.id
    previousSourceIds = parseSourceIds(existing.source_ids)
  } else {
    // 已有正式 digest：归档旧版本，新建 active 版本，并写入 supersedes 链路
    previousSourceIds = parseSourceIds(existing.source_ids)
    const newId = crypto.randomUUID()
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare('UPDATE memories SET archived = 1 WHERE id = ? AND user_id = ? AND type = ?').bind(
        existing.id,
        userId,
        'digest',
      ),
      env.DB.prepare(
        `INSERT INTO memories (id, user_id, type, subtype, title, content, scope, project_id, date, tags, source, meta, created_at)
         VALUES (?, ?, 'digest', '', ?, '', ?, ?, ?, '[]', 'digest', '{}', ?)`,
      ).bind(newId, userId, DIGEST_PLACEHOLDER_TITLE, projectId ? 'project' : 'global', projectId, date, now),
      env.DB.prepare(
        'INSERT OR IGNORE INTO memory_links (from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?)',
      ).bind(newId, existing.id, 'supersedes', now),
    ])
    digestId = newId
  }

  // 3. LLM 总结成单条事实（结构化输出）
  const dailyTexts = dailies.map((d) => `- ${d.content}`).join('\n')
  const summary = await summarize(env, date, dailyTexts)

  // 4. 写入当前 active 版本；source_ids 取旧版本与新 daily 的并集
  const sourceIds = [...new Set([...previousSourceIds, ...dailies.map((d) => d.id)])]
  await env.DB.prepare(
    `UPDATE memories SET title = ?, content = ?, content_fts = ?, tags = ?, source_ids = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  )
    .bind(
      summary.title,
      summary.content,
      segmentForIndex(`${summary.title} ${summary.content}`),
      JSON.stringify(summary.tags || []),
      JSON.stringify(sourceIds),
      Date.now(),
      digestId,
      userId,
    )
    .run()

  if (summary.entities?.length) {
    await setMemoryEntities(env, userId, digestId, summary.entities)
  }

  // 5. 标记 daily 已消费
  const dailyIds = dailies.map((d) => d.id)
  const placeholders = dailyIds.map(() => '?').join(',')
  await env.DB.prepare(`UPDATE memories SET digested_at = ? WHERE id IN (${placeholders})`)
    .bind(Date.now(), ...dailyIds)
    .run()

  // 6. 异步建向量
  if (ctx) {
    ctx.waitUntil(
      indexMemory(
        { env, runAIWithTimeout, withRetry },
        {
          id: digestId,
          user_id: userId,
          type: 'digest',
          subtype: '',
          title: summary.title,
          content: summary.content,
          project_id: projectId,
          date,
          created_at: Date.now(),
        },
      ).catch(() => undefined),
    )
  }
  return true
}

function parseSourceIds(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** 占位失败：累加 attempts，超过上限后归档，避免无界重试 */
async function recordDigestFailure(
  env: Env,
  row: { user_id: string; project_id: string; date: string },
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE memories
       SET meta = json_set(COALESCE(meta, '{}'), '$.digest_attempts',
         COALESCE(json_extract(meta, '$.digest_attempts'), 0) + 1,
         '$.last_digest_error', ?)
       WHERE type = 'digest' AND user_id = ? AND project_id = ? AND date = ?
         AND content = '' AND archived = 0`,
    ).bind(message, row.user_id, row.project_id, row.date),
    env.DB.prepare(
      `UPDATE memories SET archived = 1
       WHERE type = 'digest' AND user_id = ? AND project_id = ? AND date = ?
         AND content = '' AND archived = 0
         AND COALESCE(json_extract(meta, '$.digest_attempts'), 0) >= ?`,
    ).bind(row.user_id, row.project_id, row.date, DIGEST_MAX_ATTEMPTS),
  ])
}

async function summarize(env: Env, date: string, dailyTexts: string): Promise<DigestSummary> {
  const response = await runAIWithTimeout(env.AI, LLM_MODEL, {
    messages: [
      {
        role: 'system',
        content: `你是记忆总结助手。把指定日期的工作日志总结成一条事实记忆，输出 JSON（不要额外文字）：
{"title": "简短标题", "content": "一段可直接被未来检索引用的陈述句", "tags": ["标签"], "entities": [{"key": "region|tech|person|project|topic", "value": "具体值"}]}
要求：
- content 是凝练的事实描述，不是流水账罗列
- 区分度高的词（地区、项目名、技术栈、人名）必须出现在 title 和 content 里
- entities 抽取可过滤的分面维度，没有则为空数组
/no_think`,
      },
      { role: 'user', content: `${date} 的工作日志：\n${dailyTexts}` },
    ],
    max_tokens: 2048,
    temperature: 0.3,
    response_format: {
      type: 'json_schema',
      json_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
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
        required: ['title', 'content', 'tags', 'entities'],
        additionalProperties: false,
      },
    },
  })

  const raw =
    typeof response === 'string'
      ? response
      : ((response as { response?: string })?.response ??
        (response as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ??
        '')
  const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '')
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Digest LLM returned no JSON')
  const parsed = JSON.parse(match[0]) as DigestSummary
  if (!parsed.title || !parsed.content) throw new Error('Digest LLM missing title/content')
  return parsed
}

// ── job_runs 记录 ──

export async function startJob(env: Env, job: string, userId?: string): Promise<string> {
  const id = crypto.randomUUID()
  await env.DB.prepare('INSERT INTO job_runs (id, user_id, job, status, started_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, userId ?? null, job, 'running', Date.now())
    .run()
  return id
}

export async function finishJob(
  env: Env,
  id: string,
  status: 'completed' | 'failed',
  detail?: unknown,
): Promise<void> {
  await env.DB.prepare('UPDATE job_runs SET status = ?, detail = ?, completed_at = ? WHERE id = ?')
    .bind(status, detail ? JSON.stringify(detail) : null, Date.now(), id)
    .run()
}

export async function getLatestJob(env: Env, job: string, userId?: string): Promise<JobRun | null> {
  let sql = 'SELECT * FROM job_runs WHERE job = ?'
  const bindings: string[] = [job]
  if (userId) {
    sql += ' AND user_id = ?'
    bindings.push(userId)
  }
  sql += ' ORDER BY started_at DESC LIMIT 1'
  const row = await env.DB.prepare(sql).bind(...bindings).first<JobRun>()
  return row ?? null
}
