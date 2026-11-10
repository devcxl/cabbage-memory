import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { cors as corsMiddleware } from 'hono/cors'
import { z } from 'zod'
import type { Env, Variables, MemoryType, ApiResponse, WaitContext } from './types'
import type { MemoryQueryScope } from '@devcxl/cabbage-memory-shared'
import { DEFAULT_LIMIT, MAX_LIMIT, CRON_SCHEDULE } from './types'
import { authMiddleware } from './auth/middleware'
import {
  githubLoginUrl,
  handleGithubCallback,
  signOAuthState,
  verifySession,
  SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
} from './auth/github'
import { generateApiToken, hashToken, tokenPrefix, verifyApiToken } from './auth/tokens'
import {
  createMemory,
  listMemories,
  getMemory,
  updateMemory,
  deleteMemory,
} from './services/memory-service'
import { searchMemories } from './search/hybrid'
import { buildContext } from './services/context-service'
import { answerQuestion } from './services/ask-service'
import { runDailyDigest, digestOneGroup, startJob, finishJob, getLatestJob } from './services/digest-service'
import { tzOffsetHours, userYesterday } from './utils/tz'
import { reindexAll } from './search/indexing'
import { handleMcpPost } from './mcp/server'

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

// ── 中间件 ──

app.use('*', async (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((o: string) => o.trim())
    .filter(Boolean)
  const isWildcard = allowed.includes('*')
  const requestOrigin = c.req.header('Origin') || ''
  const isExplicitAllowed = Boolean(requestOrigin && allowed.includes(requestOrigin))

  return corsMiddleware({
    origin: () => {
      if (isExplicitAllowed) return requestOrigin
      if (isWildcard) return '*'
      return null
    },
    allowHeaders: ['Authorization', 'Content-Type', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'X-Admin-Secret'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: isExplicitAllowed,
  })(c, next)
})

app.use('*', async (c, next) => {
  const start = Date.now()
  const requestId = crypto.randomUUID()
  c.set('requestId', requestId)
  try {
    await next()
  } finally {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId,
      userId: c.get('userId') ?? null,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration: Date.now() - start,
    }))
  }
})

app.onError((err, c) => {
  const requestId = c.get('requestId') as string | undefined
  if (err instanceof HTTPException) {
    const message = err.message || c.req.path
    console.error(`[${requestId ?? '-'}] HTTP ${err.status} ${c.req.method} ${c.req.path}: ${message}`)
    return c.json({ success: false, error: message } satisfies ApiResponse<never>, err.status)
  }
  const message = err instanceof Error ? err.message : 'Unknown error'
  console.error(`[${requestId ?? '-'}] Unhandled ${c.req.method} ${c.req.path}:`, err)
  return c.json({ success: false, error: message } satisfies ApiResponse<never>, 500)
})

app.notFound((c) => c.json({ success: false, error: `Not found: ${c.req.method} ${c.req.path}` } satisfies ApiResponse<never>, 404))

// 所有 /api/* 与 /mcp 走统一认证（Bearer Token 或会话 Cookie）
app.use('/api/*', authMiddleware)
app.use('/mcp', authMiddleware)

// ── 健康检查 ──

app.get('/health', (c) => c.text('OK'))

// ── GitHub OAuth（免认证） ──

app.get('/auth/github/login', async (c) => {
  if (!c.env.GITHUB_CLIENT_ID) {
    return c.json({ success: false, error: 'GitHub OAuth not configured' } satisfies ApiResponse<never>, 500)
  }
  const state = await signOAuthState(c.env)
  const loginUrl = githubLoginUrl(c.env, new URL(c.req.url).origin)
  const res = c.redirect(loginUrl, 302)
  res.headers.append(
    'Set-Cookie',
    `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  )
  return res
})

app.get('/auth/github/callback', async (c) => {
  const code = c.req.query('code') || ''
  const state = c.req.query('state') || ''
  const stateCookie = readCookie(c.req.header('Cookie') || '', OAUTH_STATE_COOKIE)
  const origin = new URL(c.req.url).origin

  const result = await handleGithubCallback(c.env, code, state, stateCookie || '', origin)
  const res = c.redirect(result.redirect, 302)
  if (result.setCookie) res.headers.append('Set-Cookie', result.setCookie)
  // 用完即弃 state cookie
  res.headers.append('Set-Cookie', `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`)
  return res
})

app.get('/auth/logout', (c) => {
  const res = c.redirect('/', 302)
  res.headers.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`)
  return res
})

// ── 会话信息 ──

app.get('/api/me', async (c) => {
  const userId = c.get('userId') as string
  const user = await c.env.DB.prepare('SELECT id, github_id, login, name, avatar_url, created_at, last_login_at FROM users WHERE id = ?')
    .bind(userId)
    .first()
  return c.json({ success: true, data: user })
})

// ── API Token 管理 ──

const tokenCreateSchema = z.object({ name: z.string().min(1).max(100) })

app.post('/api/tokens', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => ({}))
  const parsed = tokenCreateSchema.safeParse(body)
  if (!parsed.success) {
    throw new HTTPException(400, { message: parsed.error.issues.map((i) => i.message).join(', ') })
  }

  const token = generateApiToken()
  const id = crypto.randomUUID()
  const now = Date.now()
  await c.env.DB.prepare(
    'INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, userId, parsed.data.name, await hashToken(token), tokenPrefix(token), now)
    .run()

  // 明文只在创建响应中返回一次
  return c.json({ success: true, data: { id, name: parsed.data.name, prefix: tokenPrefix(token), token, created_at: now } })
})

app.get('/api/tokens', async (c) => {
  const userId = c.get('userId') as string
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
  )
    .bind(userId)
    .all()
  return c.json({ success: true, data: results || [] })
})

app.delete('/api/tokens/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  await c.env.DB.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(Date.now(), id, userId)
    .run()
  return c.json({ success: true })
})

// ── 记忆 CRUD ──

const memoryCreateSchema = z.object({
  type: z.enum(['daily', 'fact', 'instruction']),
  subtype: z.string().max(50).optional(),
  title: z.string().max(500).optional(),
  content: z.string().min(1).max(10000),
  scope: z.enum(['global', 'project']).optional(),
  project_id: z.string().max(200).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
})

const memoryUpdateSchema = z.object({
  title: z.string().max(500).optional(),
  content: z.string().min(1).max(10000).optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
  project_id: z.string().max(200).optional(),
})

const searchSchema = z.object({
  query: z.string().min(1).max(1000),
  topK: z.number().int().min(1).max(50).optional(),
  type: z.enum(['daily', 'fact', 'instruction', 'digest']).optional(),
  scope: z.enum(['project', 'global', 'all']).optional(),
  project_id: z.string().max(200).optional(),
  facets: z.record(z.string(), z.string().max(200)).optional(),
})

const askSchema = z.object({
  question: z.string().min(1).max(1000),
  topK: z.number().int().min(1).max(50).optional(),
  project_id: z.string().max(200).optional(),
})

function parseListQuery(c: { req: { query: (k: string) => string | undefined } }) {
  const scopeRaw = c.req.query('scope')
  const scope: MemoryQueryScope | undefined =
    scopeRaw === 'project' || scopeRaw === 'global' || scopeRaw === 'all' ? scopeRaw : undefined
  return {
    type: c.req.query('type') as MemoryType | undefined,
    subtype: c.req.query('subtype') || undefined,
    scope,
    project_id: c.req.query('project_id') || undefined,
    date: c.req.query('date') || undefined,
    limit: Math.min(parseInt(c.req.query('limit') || String(DEFAULT_LIMIT)) || DEFAULT_LIMIT, MAX_LIMIT),
    offset: parseInt(c.req.query('offset') || '0') || 0,
  }
}

app.get('/api/memories', async (c) => {
  const userId = c.get('userId') as string
  const results = await listMemories(c.env, userId, parseListQuery(c))
  return c.json({ success: true, data: results })
})

app.post('/api/memories', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json()
  const parsed = memoryCreateSchema.safeParse(body)
  if (!parsed.success) {
    throw new HTTPException(400, { message: `Invalid input: ${parsed.error.issues.map((i) => i.message).join(', ')}` })
  }
  const result = await createMemory(c.env, userId, parsed.data, c.executionCtx)
  return c.json({ success: true, data: result })
})

app.post('/api/memories/search', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json()
  const parsed = searchSchema.safeParse(body)
  if (!parsed.success) {
    throw new HTTPException(400, { message: `Invalid input: ${parsed.error.issues.map((i) => i.message).join(', ')}` })
  }
  const results = await searchMemories(c.env, {
    query: parsed.data.query,
    userId,
    topK: parsed.data.topK,
    type: parsed.data.type,
    scope: parsed.data.scope,
    projectId: parsed.data.project_id,
    facets: parsed.data.facets,
  })
  return c.json({ success: true, data: results })
})

app.get('/api/memories/:id', async (c) => {
  const userId = c.get('userId') as string
  const record = await getMemory(c.env, userId, c.req.param('id'))
  if (!record) throw new HTTPException(404, { message: 'Not found' })
  return c.json({ success: true, data: record })
})

app.put('/api/memories/:id', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json()
  const parsed = memoryUpdateSchema.safeParse(body)
  if (!parsed.success) {
    throw new HTTPException(400, { message: `Invalid input: ${parsed.error.issues.map((i) => i.message).join(', ')}` })
  }
  await updateMemory(c.env, userId, c.req.param('id'), parsed.data, c.executionCtx)
  return c.json({ success: true })
})

app.delete('/api/memories/:id', async (c) => {
  const userId = c.get('userId') as string
  await deleteMemory(c.env, userId, c.req.param('id'))
  return c.json({ success: true })
})

// ── 上下文 / 问答 / 统计 ──

app.get('/api/context', async (c) => {
  const userId = c.get('userId') as string
  const context = await buildContext(c.env, userId, c.req.query('project_id') || '')
  return c.json({ success: true, data: { context } })
})

app.post('/api/ask', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json()
  const parsed = askSchema.safeParse(body)
  if (!parsed.success) {
    throw new HTTPException(400, { message: `Invalid input: ${parsed.error.issues.map((i) => i.message).join(', ')}` })
  }
  const response = await answerQuestion(c.env, {
    question: parsed.data.question,
    userId,
    projectId: parsed.data.project_id,
    topK: parsed.data.topK,
  })
  return c.json({ success: true, data: response })
})

app.get('/api/stats', async (c) => {
  const userId = c.get('userId') as string
  const [typeRows, projectRow, undigestedRow] = await Promise.all([
    c.env.DB.prepare(
      `SELECT type, COUNT(*) AS count FROM memories WHERE user_id = ? AND archived = 0 GROUP BY type`,
    )
      .bind(userId)
      .all<{ type: MemoryType; count: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(DISTINCT project_id) AS count FROM memories WHERE user_id = ? AND archived = 0 AND project_id != ''`,
    )
      .bind(userId)
      .first<{ count: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memories WHERE user_id = ? AND type = 'daily' AND archived = 0 AND digested_at IS NULL`,
    )
      .bind(userId)
      .first<{ count: number }>(),
  ])

  const byType: Record<MemoryType, number> = { daily: 0, fact: 0, instruction: 0, digest: 0 }
  let total = 0
  for (const row of typeRows.results || []) {
    byType[row.type] = row.count
    total += row.count
  }
  return c.json({
    success: true,
    data: { total, byType, projectCount: projectRow?.count ?? 0, undigestedCount: undigestedRow?.count ?? 0 },
  })
})

// ── digest / reindex / 数据修复 ──

app.post('/api/digest', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => ({}))
  const beforeDate = body.date || undefined
  // 手动触发：仅处理该用户（cron 版本会处理全部用户）
  const result = await runUserDigest(c.env, userId, beforeDate, c.executionCtx)
  return c.json({ success: true, data: result })
})

app.get('/api/digest', async (c) => {
  const userId = c.get('userId') as string
  const status = await getLatestJob(c.env, 'digest', userId)
  return c.json({ success: true, data: status })
})

app.post('/api/reindex', async (c) => {
  const userId = c.get('userId') as string
  const limitParam = c.req.query('limit')
  const offsetParam = c.req.query('offset')
  const limit = limitParam ? parseInt(limitParam) : undefined
  const offset = offsetParam ? parseInt(offsetParam) : undefined
  const result = await reindexAll(c.env, userId, {
    force: c.req.query('force') === '1',
    limit: limit && !isNaN(limit) ? limit : undefined,
    offset: offset && !isNaN(offset) ? offset : undefined,
  })
  return c.json({ success: true, data: result })
})

/** 将旧 JWT sub 下的存量数据归属到当前登录用户（迁移脚本用，需 ADMIN_SECRET 鉴权） */
app.post('/api/admin/remap-user', async (c) => {
  const adminSecret = c.env.ADMIN_SECRET
  const providedSecret = c.req.header('X-Admin-Secret')
  if (!adminSecret || providedSecret !== adminSecret) {
    throw new HTTPException(403, { message: 'Admin secret required for remap operation' })
  }

  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => ({}))
  const oldUserId = String(body.old_user_id || '')
  if (!oldUserId || oldUserId === userId) {
    throw new HTTPException(400, { message: 'old_user_id is required and must differ from current user' })
  }

  const tables = ['memories', 'memory_entities', 'api_tokens'] as const
  const remapped: Record<string, number> = {}
  for (const table of tables) {
    const result = await c.env.DB.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`)
      .bind(userId, oldUserId)
      .run()
    remapped[table] = result.meta?.changes ?? 0
  }
  return c.json({ success: true, data: { remapped } })
})

// ── MCP Streamable HTTP ──

app.post('/mcp', async (c) => {
  const userId = c.get('userId') as string
  let body: { jsonrpc?: string; id?: string | number | null; method?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
  }
  if (!body.method) {
    return c.json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32600, message: 'Invalid Request' } }, 400)
  }

  const response = await handleMcpPost(c.env, c.executionCtx, userId, body as Parameters<typeof handleMcpPost>[3])
  if (response.body === undefined) return c.body(null, 202)
  return c.json(response.body, 200 as const)
})

// GET /mcp：不提供 server→client SSE 流
app.get('/mcp', (c) => c.json({ success: false, error: 'Method not allowed' } satisfies ApiResponse<never>, 405))

// ── 供测试/复用的导出 ──

/** 手动触发指定日期（默认昨天）的 digest，仅处理当前用户 */
export async function runUserDigest(
  env: Env,
  userId: string,
  beforeDate: string | undefined,
  ctx?: WaitContext,
) {
  const offset = tzOffsetHours(env)
  const date = beforeDate || userYesterday(offset)
  const jobId = await startJob(env, 'digest-manual', userId)
  try {
    const groups = await env.DB.prepare(
      `SELECT project_id, COUNT(*) AS cnt FROM memories
       WHERE user_id = ? AND type = 'daily' AND date = ? AND digested_at IS NULL AND archived = 0
       GROUP BY project_id`,
    )
      .bind(userId, date)
      .all<{ project_id: string; cnt: number }>()

    let processed = 0
    for (const group of groups.results || []) {
      if (await digestOneGroup(env, userId, group.project_id, date, ctx)) processed++
    }
    await finishJob(env, jobId, 'completed', { processed, date })
    return { processed, date }
  } catch (error) {
    await finishJob(env, jobId, 'failed', { error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

function readCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (event.cron === CRON_SCHEDULE) {
      ctx.waitUntil(runDailyDigest(env, ctx))
    }
  },
}

export type AppEnv = { Bindings: Env; Variables: Variables }
export { verifyApiToken, verifySession }
