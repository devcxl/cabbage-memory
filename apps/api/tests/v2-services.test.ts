import test from 'node:test'
import assert from 'node:assert/strict'
import { validateSubtype, createMemory } from '../src/services/memory-service'
import {
  DIGEST_BACKFILL_LIMIT,
  DIGEST_MAX_ATTEMPTS,
  getLatestJob,
  runDailyDigest,
} from '../src/services/digest-service'
import { handleMcpPost } from '../src/mcp/server'
import { generateApiToken, hashToken } from '../src/auth/tokens'
import { isAllowed } from '../src/auth/github'
import { userYesterday } from '../src/utils/tz'
import type { Env, MemoryRecord } from '../src/types'
import { makeRecord, createMockEnv } from './helpers'

// ── subtype 校验 ──

test('subtype 校验：fact/instruction 合法细分放行，非法组合拒绝', () => {
  assert.equal(validateSubtype('fact', 'preference'), 'preference')
  assert.equal(validateSubtype('instruction', 'rule'), 'rule')
  assert.equal(validateSubtype('daily', ''), '')
  assert.throws(() => validateSubtype('fact', 'rule'))
  assert.throws(() => validateSubtype('daily', 'preference'))
})

// ── API Token ──

test('API Token：格式固定且哈希稳定', async () => {
  const token = generateApiToken()
  assert.ok(token.startsWith('opm_'))
  assert.ok(token.length > 40)
  assert.equal(await hashToken(token), await hashToken(token))
  assert.notEqual(await hashToken(token), await hashToken(generateApiToken()))
})

// ── 时区 ──

test('东八区昨天计算：跨时区日期边界', () => {
  // 2026-09-02T16:10Z = 北京时间 09-03 00:10，昨天 = 09-02
  const ts = Date.UTC(2026, 8, 2, 16, 10)
  assert.equal(userYesterday(8, ts), '2026-09-02')
  // 2026-09-02T12:00Z = 北京时间 09-02 20:00，昨天 = 09-01
  const ts2 = Date.UTC(2026, 8, 2, 12, 0)
  assert.equal(userYesterday(8, ts2), '2026-09-01')
})

// ── MCP JSON-RPC 分发 ──

test('MCP：initialize 与 tools/list 正常返回', async () => {
  const env = createMockEnv({})
  const init = await handleMcpPost(env, undefined, 'u-1', {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  })
  assert.equal(init.status, 200)
  const result = init.body?.result as { serverInfo: { name: string }; capabilities: { tools: object } }
  assert.equal(result.serverInfo.name, 'cabbage-memory')

  const list = await handleMcpPost(env, undefined, 'u-1', { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const tools = (list.body?.result as { tools: Array<{ name: string }> }).tools
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['memory_add', 'memory_context', 'memory_delete', 'memory_get', 'memory_search', 'memory_update', 'memory_digest_status'].sort(),
  )
})

test('MCP：通知请求返回 202，未知方法返回 -32601', async () => {
  const env = createMockEnv({})
  const notify = await handleMcpPost(env, undefined, 'u-1', { jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(notify.status, 202)
  assert.equal(notify.body, undefined)

  const unknown = await handleMcpPost(env, undefined, 'u-1', { jsonrpc: '2.0', id: 3, method: 'bogus/method' })
  assert.equal(unknown.body?.error?.code, -32601)
})

test('MCP：tools/call 正常调用且纯文本不被 JSON 二次转义', async () => {
  const env = createMockEnv({})
  const res = await handleMcpPost(env, undefined, 'u-1', {
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'memory_digest_status', arguments: {} },
  })
  assert.equal(res.status, 200)
  const result = res.body?.result as { content: Array<{ type: string; text: string }>; isError: boolean }
  assert.equal(result.isError, false)
})

test('OAuth allowlist：未配置时首位认领，已存在用户正常重复登录，拒绝未授权第三方', async () => {
  const userRows: Array<{ id: string; github_id: number; login: string }> = []
  const mockDb = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT id FROM users WHERE github_id = ?')) {
                const target = userRows.find((u) => u.github_id === args[0])
                return (target ? { id: target.id } : null) as T
              }
              return null as T
            },
          }
        },
        async first<T>() {
          if (sql.includes('SELECT COUNT(*) AS count FROM users')) {
            return { count: userRows.length } as T
          }
          return null as T
        },
      }
    },
  }
  const env = { DB: mockDb, OAUTH_ALLOWLIST: '' } as unknown as Env

  // 1. 数据库为空：首个用户允许认领
  const firstUser = { id: 101, login: 'alice', name: 'Alice', avatar_url: null }
  assert.equal(await isAllowed(env, firstUser), true)

  // 写入首个用户
  userRows.push({ id: 'u-1', github_id: 101, login: 'alice' })

  // 2. 数据库已有用户：已有用户再次登录仍允许
  assert.equal(await isAllowed(env, firstUser), true)

  // 3. 数据库已有用户：未授权的陌生用户被拦截
  const intruder = { id: 999, login: 'mallory', name: 'Mallory', avatar_url: null }
  assert.equal(await isAllowed(env, intruder), false)
})

// ── digest 幂等占位 ──

/** 可变存储 mock：覆盖 digest 依赖的 SQL 语句 */
function createDigestEnv(existing: MemoryRecord[], opts: { llmError?: boolean } = {}) {
  const rows = [...existing]
  const digestKeys = new Set(
    existing
      .filter((r) => r.type === 'digest' && r.archived === 0)
      .map((r) => `${r.user_id}|${r.project_id}|${r.date}`),
  )
  const links: Array<{ from_id: string; to_id: string; relation: string }> = []
  const llmCalls: unknown[] = []

  const env = {
    DB: {
      prepare(sql: string) {
        const stmt = {
          bind(...args: unknown[]) {
            return {
              all: async <T>() => ({ results: query(sql, args) as T[] }),
              first: async <T>() => (query(sql, args) as T[])[0] ?? null,
              run: async () => exec(sql, args),
            }
          },
          all: async <T>() => ({ results: query(sql, []) as T[] }),
          first: async <T>() => (query(sql, []) as T[])[0] ?? null,
          run: async () => exec(sql, []),
        }
        return stmt
      },
      async batch(statements: Array<{ run: () => Promise<unknown> }>) {
        for (const statement of statements) await statement.run()
        return []
      },
    } as unknown as Env['DB'],
    VEC: { async upsert() {}, async deleteByIds() {} } as unknown as Env['VEC'],
    AI: {
      async run(_model: string, input: { messages?: unknown[] }) {
        if (Array.isArray(input.messages)) {
          llmCalls.push(input)
          if (opts.llmError) throw new Error('LLM down')
          return { response: JSON.stringify({ title: '9月1日工作总结', content: '完成华东区销售额统计。', tags: ['销售'], entities: [{ key: 'region', value: '华东' }] }) }
        }
        return { data: [[0.1]] }
      },
    } as unknown as Env['AI'],
    JWT_SECRET: 'test',
    TZ_OFFSET_HOURS: '8',
  } as Env

  function query(sql: string, args: unknown[]): unknown[] {
    // digestOneGroup 的单组 daily 查询（带 project_id 过滤）
    if (sql.includes("type = 'daily'") && sql.includes('project_id = ?')) {
      const [userId, projectId, date] = args as string[]
      return rows.filter(
        (r) => r.type === 'daily' && r.user_id === userId && r.project_id === projectId && r.date === date && !r.digested_at && r.archived === 0,
      )
    }
    // runDailyDigest 的分组查询（GROUP BY user_id, project_id, date）
    if (sql.includes("type = 'daily'") && sql.includes('GROUP BY user_id')) {
      const cutoff = args[0] as string
      const isBackfill = sql.includes('date <= ?')
      const limit = sql.includes('LIMIT ?') ? (args[1] as number) : undefined
      const groups = new Map<string, { user_id: string; project_id: string; date: string }>()
      for (const r of rows) {
        if (r.type !== 'daily' || r.archived !== 0 || r.digested_at) continue
        if (isBackfill ? r.date > cutoff : r.date !== cutoff) continue
        const key = `${r.user_id}|${r.project_id}|${r.date}`
        if (!groups.has(key)) groups.set(key, { user_id: r.user_id, project_id: r.project_id, date: r.date })
      }
      let result = [...groups.values()].sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          a.user_id.localeCompare(b.user_id) ||
          a.project_id.localeCompare(b.project_id),
      )
      if (limit !== undefined) result = result.slice(0, limit)
      return result
    }
    if (sql.includes("type = 'digest'") && sql.includes("content = ''") && sql.includes('SELECT user_id, project_id, date')) {
      return rows.filter((r) => r.type === 'digest' && r.content === '' && r.archived === 0)
    }
    if (sql.includes("type = 'digest'") && sql.includes('SELECT id, content, source_ids FROM memories')) {
      const [userId, projectId, date] = args as string[]
      return rows.filter(
        (r) =>
          r.type === 'digest' &&
          r.user_id === userId &&
          r.project_id === projectId &&
          r.date === date &&
          r.archived === 0,
      )
    }
    if (sql.includes("type = 'digest'") && sql.includes('SELECT id FROM memories')) {
      const [userId, projectId, date] = args as string[]
      return rows.filter((r) => r.type === 'digest' && r.user_id === userId && r.project_id === projectId && r.date === date && r.archived === 0)
    }
    if (sql.includes('FROM memory_entities')) return []
    return []
  }

  function exec(sql: string, args: unknown[]): { meta: { changes: number } } {
    if (sql.includes('INSERT INTO memories') && !sql.includes('INSERT OR IGNORE')) {
      const [id, userId, , scope, projectId, date] = args as string[]
      rows.push(
        makeRecord({
          id,
          user_id: userId,
          type: 'digest',
          title: '__digest_pending__',
          content: '',
          scope: scope as 'global',
          project_id: projectId,
          date,
        }),
      )
      digestKeys.add(`${userId}|${projectId}|${date}`)
      return { meta: { changes: 1 } }
    }
    if (sql.includes('INSERT OR IGNORE INTO memories')) {
      const [id, userId, , scope, projectId, date] = args as string[]
      const key = `${userId}|${projectId}|${date}`
      if (digestKeys.has(key)) return { meta: { changes: 0 } }
      digestKeys.add(key)
      rows.push(makeRecord({ id, user_id: userId, type: 'digest', title: '__digest_pending__', content: '', scope: scope as 'global', project_id: projectId, date }))
      return { meta: { changes: 1 } }
    }
    if (sql.includes('UPDATE memories SET title')) {
      const [title, content, , tags, sourceIds, , id] = args as unknown[]
      const row = rows.find((r) => r.id === id)
      if (row) {
        row.title = title as string
        row.content = content as string
        row.tags = tags as string
        row.source_ids = sourceIds as string
      }
      return { meta: { changes: row ? 1 : 0 } }
    }
    if (sql.includes('SET digested_at')) {
      const [now, ...ids] = args as unknown[]
      let changes = 0
      for (const row of rows) {
        if ((ids as string[]).includes(row.id)) {
          row.digested_at = now as number
          changes++
        }
      }
      return { meta: { changes } }
    }
    if (sql.includes('INSERT OR IGNORE INTO memory_entities')) {
      // 记录实体写入（仅计数）
      return { meta: { changes: 1 } }
    }
    if (sql.includes('INSERT OR IGNORE INTO memory_links')) {
      const [fromId, toId, relation] = args as string[]
      links.push({ from_id: fromId, to_id: toId, relation })
      return { meta: { changes: 1 } }
    }
    if (sql.includes('SET meta = json_set') && sql.includes('digest_attempts')) {
      const [message, userId, projectId, date] = args as string[]
      const row = rows.find(
        (r) =>
          r.type === 'digest' &&
          r.user_id === userId &&
          r.project_id === projectId &&
          r.date === date &&
          r.content === '' &&
          r.archived === 0,
      )
      if (!row) return { meta: { changes: 0 } }
      const meta = JSON.parse(row.meta || '{}') as { digest_attempts?: number }
      meta.digest_attempts = (meta.digest_attempts || 0) + 1
      row.meta = JSON.stringify({ ...meta, last_digest_error: message })
      return { meta: { changes: 1 } }
    }
    if (sql.includes('SET archived = 1') && sql.includes('digest_attempts')) {
      const [userId, projectId, date, maxAttempts] = args as unknown[]
      const row = rows.find(
        (r) =>
          r.type === 'digest' &&
          r.user_id === userId &&
          r.project_id === projectId &&
          r.date === date &&
          r.content === '' &&
          r.archived === 0,
      )
      if (!row) return { meta: { changes: 0 } }
      const meta = JSON.parse(row.meta || '{}') as { digest_attempts?: number }
      if ((meta.digest_attempts || 0) < (maxAttempts as number)) return { meta: { changes: 0 } }
      row.archived = 1
      digestKeys.delete(`${row.user_id}|${row.project_id}|${row.date}`)
      return { meta: { changes: 1 } }
    }
    if (sql.includes('SET archived = 1') && sql.includes('type = ?') && sql.includes('id = ?')) {
      const [id, userId, type] = args as string[]
      const row = rows.find((r) => r.id === id && r.user_id === userId && r.type === type)
      if (!row) return { meta: { changes: 0 } }
      row.archived = 1
      if (row.type === 'digest') digestKeys.delete(`${row.user_id}|${row.project_id}|${row.date}`)
      return { meta: { changes: 1 } }
    }
    return { meta: { changes: 0 } }
  }

  return { env, rows, llmCalls, links }
}

test('digest：成功生成单条事实并标记 daily 已消费', async () => {
  const testDate = '2026-09-01'
  const daily = makeRecord({
    id: 'd-1',
    type: 'daily',
    subtype: '',
    title: '',
    content: '修复了登录 bug',
    date: testDate,
  })
  const { env, rows } = createDigestEnv([daily])

  const result = await runDailyDigest(env, undefined, testDate)
  assert.equal(result.processed, 1)

  const digest = rows.find((r) => r.type === 'digest')
  assert.ok(digest)
  assert.equal(digest!.content, '完成华东区销售额统计。')
  assert.notEqual(digest!.content, '__digest_pending__')
  assert.equal(daily.digested_at !== null, true)
})

test('digest：重复执行不会产生第二条 digest（幂等占位）', async () => {
  const testDate = '2026-09-01'
  const daily = makeRecord({
    id: 'd-1',
    type: 'daily',
    subtype: '',
    title: '',
    content: '修复了登录 bug',
    date: testDate,
  })
  const { env, rows } = createDigestEnv([daily])

  await runDailyDigest(env, undefined, testDate)
  const countAfterFirst = rows.filter((r) => r.type === 'digest').length
  assert.equal(countAfterFirst, 1)

  // daily 已消费 → 第二次运行无待处理数据
  const result = await runDailyDigest(env, undefined, testDate)
  assert.equal(result.processed, 0)
  assert.equal(rows.filter((r) => r.type === 'digest').length, 1)
})

test('digest：无 daily 时直接返回，不写 job 失败', async () => {
  const { env } = createDigestEnv([])
  const result = await runDailyDigest(env)
  assert.equal(result.processed, 0)
  assert.equal(result.failed, 0)
})

// createMemory 冒烟：mock DB + 无 AI 时不抛错
test('createMemory：AI 未配置时仍完成 D1 写入', async () => {
  const inserts: Array<{ sql: string; args: unknown[] }> = []
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            inserts.push({ sql, args })
            return {
              async run() {
                return { meta: { changes: 1 } }
              },
              async all<T>() {
                return { results: [] as T[] }
              },
              async first<T>() {
                return null as T
              },
            }
          },
        }
      },
    } as unknown as Env['DB'],
    VEC: undefined,
    AI: undefined,
    JWT_SECRET: 'test',
    TZ_OFFSET_HOURS: '8',
  } as unknown as Env

  const result = await createMemory(env, 'u-1', { type: 'daily', content: '今天写了新表结构' })
  assert.ok(result.id)
  assert.equal(inserts.length, 1)
  assert.ok(inserts[0].sql.includes('INSERT INTO memories'))
})

test('digest：cron 补扫漏跑日期并保持幂等', async () => {
  const oldDaily = makeRecord({ id: 'd-old', type: 'daily', date: '2026-09-01', content: '旧日志' })
  const recentDaily = makeRecord({ id: 'd-recent', type: 'daily', date: '2026-09-02', content: '新日志' })
  const { env, rows } = createDigestEnv([oldDaily, recentDaily])

  const result = await runDailyDigest(env)
  assert.equal(result.processed, 2)
  assert.notEqual(oldDaily.digested_at, null)
  assert.notEqual(recentDaily.digested_at, null)
  assert.equal(rows.filter((r) => r.type === 'digest').length, 2)

  const again = await runDailyDigest(env)
  assert.equal(again.processed, 0)
  assert.equal(rows.filter((r) => r.type === 'digest').length, 2)
})

test('digest：cron 单次补扫有上限', async () => {
  const dailies = Array.from({ length: DIGEST_BACKFILL_LIMIT + 1 }, (_, i) =>
    makeRecord({
      id: `d-${i}`,
      type: 'daily',
      date: `2026-08-${String(i + 1).padStart(2, '0')}`,
      content: `日志 ${i}`,
    }),
  )
  const { env, rows } = createDigestEnv(dailies)

  const result = await runDailyDigest(env)
  assert.equal(result.processed, DIGEST_BACKFILL_LIMIT)
  assert.equal(dailies.filter((d) => d.digested_at === null).length, 1)
  assert.equal(rows.filter((r) => r.type === 'digest').length, DIGEST_BACKFILL_LIMIT)
})

test('digest：同日新增 daily 时保留旧摘要并新建版本', async () => {
  const date = '2026-09-01'
  const oldDigest = makeRecord({
    id: 'digest-old',
    type: 'digest',
    subtype: '',
    title: '旧摘要',
    content: '旧版本摘要',
    date,
    source: 'digest',
    source_ids: JSON.stringify(['d-old']),
  })
  const newDaily = makeRecord({ id: 'd-new', type: 'daily', date, content: '新增日志' })
  const { env, rows, links } = createDigestEnv([oldDigest, newDaily])

  const result = await runDailyDigest(env, undefined, date)
  assert.equal(result.processed, 1)

  const active = rows.filter((r) => r.type === 'digest' && r.archived === 0)
  assert.equal(active.length, 1)
  assert.notEqual(active[0].id, 'digest-old')
  assert.equal(active[0].content, '完成华东区销售额统计。')
  assert.deepEqual((JSON.parse(active[0].source_ids || '[]') as string[]).sort(), ['d-new', 'd-old'])

  const old = rows.find((r) => r.id === 'digest-old')
  assert.ok(old)
  assert.equal(old!.archived, 1)
  assert.equal(old!.content, '旧版本摘要')
  assert.ok(
    links.some(
      (l) =>
        l.from_id === active[0].id &&
        l.to_id === 'digest-old' &&
        l.relation === 'supersedes',
    ),
  )
})

test('digest：占位连续失败达到上限后归档', async () => {
  const date = '2026-09-01'
  const pending = makeRecord({
    id: 'digest-pending',
    type: 'digest',
    subtype: '',
    title: '__digest_pending__',
    content: '',
    date,
    source: 'digest',
    meta: JSON.stringify({ digest_attempts: DIGEST_MAX_ATTEMPTS - 1 }),
  })
  const daily = makeRecord({ id: 'd-1', type: 'daily', date, content: '日志' })
  const { env, rows } = createDigestEnv([pending, daily], { llmError: true })

  // targetDate 指向另一天，避免同一 daily 在补扫阶段再次触发
  const result = await runDailyDigest(env, undefined, '2026-09-02')
  assert.equal(result.processed, 0)
  assert.equal(result.failed, 1)

  const row = rows.find((r) => r.id === 'digest-pending')
  assert.ok(row)
  assert.equal(row!.archived, 1)
  const meta = JSON.parse(row!.meta) as { digest_attempts: number }
  assert.equal(meta.digest_attempts, DIGEST_MAX_ATTEMPTS)
})

test('getLatestJob：按 user_id 过滤，避免读他人任务', async () => {
  const calls: Array<{ sql: string; args: unknown[] }> = []
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            calls.push({ sql, args })
            return { first: async () => null }
          },
        }
      },
    } as unknown as Env['DB'],
  } as Env

  await getLatestJob(env, 'digest', 'u-1')

  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /user_id = \?/)
  assert.deepEqual(calls[0].args, ['digest', 'u-1'])
})
