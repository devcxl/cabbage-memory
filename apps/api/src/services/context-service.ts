import type { Env } from '../types'
import { DEFAULT_LIMIT } from '../types'

/**
 * 组装 system prompt 注入用的上下文 Markdown。
 * 服务端化：以后调整注入策略只改 Worker，不用发插件版本。
 */

interface ContextRow {
  title: string
  content: string
  created_at: number
  /** fact 行用于区分项目知识与全局知识 */
  project_id?: string
}

export async function buildContext(env: Env, userId: string, projectId: string): Promise<string> {
  const sections: string[] = []

  // 1. 身份（instruction: identity）
  const identity = await env.DB.prepare(
    `SELECT title, content, created_at FROM memories
     WHERE user_id = ? AND type = 'instruction' AND subtype = 'identity' AND archived = 0
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userId)
    .all<ContextRow>()
  const identitySection = section('IDENTITY', identity.results || [])
  if (identitySection) sections.push(identitySection)

  // 2. 用户偏好（fact: preference）
  const preferences = await env.DB.prepare(
    `SELECT title, content, created_at FROM memories
     WHERE user_id = ? AND type = 'fact' AND subtype = 'preference' AND archived = 0
     ORDER BY created_at DESC LIMIT 20`,
  )
    .bind(userId)
    .all<ContextRow>()
  const prefSection = section('USER PREFERENCES', preferences.results || [])
  if (prefSection) sections.push(prefSection)

  // 3. 规则与工作流（instruction: rule/workflow，按 meta.priority 排序）
  const rules = await env.DB.prepare(
    `SELECT title, content, created_at FROM memories
     WHERE user_id = ? AND type = 'instruction' AND subtype IN ('rule', 'workflow') AND archived = 0
       AND (project_id = ? OR project_id = '')
     ORDER BY COALESCE(json_extract(meta, '$.priority'), 0) DESC, created_at DESC LIMIT 20`,
  )
    .bind(userId, projectId || '')
    .all<ContextRow>()
  const ruleSection = section('RULES & WORKFLOWS', rules.results || [])
  if (ruleSection) sections.push(ruleSection)

  // 4. 项目事实（fact：当前项目优先，其次全局知识）
  if (projectId) {
    const facts = await env.DB.prepare(
      `SELECT title, content, created_at, project_id FROM memories
       WHERE user_id = ? AND type = 'fact' AND (project_id = ? OR project_id = '') AND archived = 0
       ORDER BY CASE WHEN project_id = ? THEN 0 ELSE 1 END, created_at DESC LIMIT ?`,
    )
      .bind(userId, projectId, projectId, DEFAULT_LIMIT)
      .all<ContextRow>()
    const factSection = knowledgeSection(projectId, facts.results || [])
    if (factSection) sections.push(factSection)
  }

  // 5. 最近 digest（跨项目都注入：每日总结是高价值事实）
  const digests = await env.DB.prepare(
    `SELECT title, content, created_at FROM memories
     WHERE user_id = ? AND type = 'digest' AND archived = 0
     ORDER BY date DESC LIMIT 3`,
  )
    .bind(userId)
    .all<ContextRow>()
  const digestSection = section('RECENT DAILY DIGESTS', digests.results || [])
  if (digestSection) sections.push(digestSection)

  if (sections.length === 0) return ''
  return `# Memory Context\n\n${sections.join('\n\n---\n\n')}`
}

function knowledgeSection(projectId: string, rows: ContextRow[]): string {
  if (!rows.length) return ''
  const items = rows
    .map((r) => {
      const heading = r.title && r.title !== '__digest_pending__' ? `**${r.title}**\n` : ''
      const scope = r.project_id ? '' : ' _(global)_'
      return `${heading}${r.content}${scope}`
    })
    .join('\n\n')
  return `## PROJECT KNOWLEDGE (${projectId})\n\n${items}`
}

function section(title: string, rows: ContextRow[]): string {
  if (!rows.length) return ''
  const items = rows
    .map((r) => {
      const heading = r.title && r.title !== '__digest_pending__' ? `**${r.title}**\n` : ''
      return `${heading}${r.content}`
    })
    .join('\n\n')
  return `## ${title}\n\n${items}`
}
