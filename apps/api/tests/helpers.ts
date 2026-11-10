import type { Env, MemoryRecord } from '../src/types'

/** 构造一条统一的记忆行 */
export function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'r-1',
    user_id: 'u-1',
    type: 'fact',
    subtype: 'knowledge',
    title: '销售数据',
    content: '华北销售额 100 万',
    scope: 'global',
    project_id: '',
    date: '',
    tags: '[]',
    source: 'agent',
    source_ids: null,
    meta: '{}',
    created_at: 1_700_000_000_000,
    updated_at: null,
    digested_at: null,
    archived: 0,
    ...overrides,
  }
}

export interface MockVectorMatch {
  id: string
  score?: number
}

/**
 * 构造最小 Env mock：
 * - DB：按 SQL 片段路由到注入的处理器
 * - VEC：固定向量召回结果
 * - AI：embedding + 可选 LLM 响应（runAI handler 注入）
 */
export function createMockEnv(opts: {
  ftsAndRows?: Array<{ id: string; snippet?: string; rank?: number }>
  ftsOrRows?: Array<{ id: string; snippet?: string; rank?: number }>
  records?: MemoryRecord[]
  vectorMatches?: MockVectorMatch[]
  entityRows?: Array<{ memory_id: string; key: string; value: string }>
  llmResponse?: unknown
  /** 自定义 SQL 路由；返回 undefined 时走默认路由 */
  queryHandler?: (sql: string, args: unknown[]) => unknown[] | undefined
}) {
  const {
    ftsAndRows = [],
    ftsOrRows = [],
    records = [],
    vectorMatches = [],
    entityRows = [],
    llmResponse,
  } = opts

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all<T>() {
              return { results: routeQuery(sql, args) as T[] }
            },
            async first<T>() {
              const results = routeQuery(sql, args) as T[]
              return results[0] ?? null
            },
            async run() {
              return { meta: { changes: 0 } }
            },
          }
        },
      }
    },
  }

  function routeQuery(sql: string, args: unknown[]): unknown[] {
    const custom = opts.queryHandler?.(sql, args)
    if (custom !== undefined) return custom

    if (sql.includes('FROM memory_entities')) {
      const key = args[1] as string
      const value = args[2] as string
      return entityRows.filter((e) => e.key === key && e.value === value)
    }
    if (sql.includes('FROM memories_fts')) {
      const matchExpr = String(args[0])
      // AND 模式：全文匹配表达式以 AND 连接
      const rows = matchExpr.includes(' AND ') ? ftsAndRows : ftsOrRows
      // 模拟 SQL 在 FTS 查询内过滤 archived 的行为
      if (sql.includes('archived = 0')) {
        return rows.filter((r) => {
          const record = records.find((x) => x.id === r.id)
          return !record || record.archived === 0
        })
      }
      return rows
    }
    if (sql.includes('FROM memories') && sql.includes('id IN')) {
      const ids = (args as string[]).slice(0, args.length - 1)
      return records.filter((r) => ids.includes(r.id) && r.archived === 0)
    }
    return []
  }

  const vec = {
    async query() {
      return { matches: vectorMatches.map((m) => ({ id: m.id, score: m.score ?? 0.9 })) }
    },
    async upsert() {},
    async deleteByIds() {},
    async insert() {},
    async describe() {
      return {}
    },
    async getByIds() {
      return { results: [] }
    },
  }

  const ai = {
    async run(_model: string, input: { text?: unknown }) {
      // embedding：批量输入返回对应数量的向量
      const count = Array.isArray(input.text) ? input.text.length : 1
      return { data: Array.from({ length: count }, () => [0.1, 0.2, 0.3]) }
    },
  }

  const env = {
    DB: db as unknown as Env['DB'],
    VEC: vec as unknown as Env['VEC'],
    AI: (llmResponse ? mockLLM(ai, llmResponse) : ai) as unknown as Env['AI'],
    JWT_SECRET: 'test-secret',
    TZ_OFFSET_HOURS: '8',
  }
  return env as Env
}

function mockLLM(base: Env['AI'], llmResponse: unknown): Env['AI'] {
  return {
    async run(model: string, input: { messages?: unknown[] }) {
      // embedding 走 base，LLM（带 messages）返回注入的响应
      if (Array.isArray((input as { messages?: unknown[] }).messages)) {
        if (typeof llmResponse === 'function') return (llmResponse as (input: unknown) => unknown)(input)
        return llmResponse
      }
      return base.run(model, input)
    },
  } as Env['AI']
}
