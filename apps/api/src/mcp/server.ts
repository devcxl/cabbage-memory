import type { Env, WaitContext, MemoryType } from '../types'
import { McpError } from '../utils/errors'
import { createMemory, listMemories, getMemory, updateMemory, deleteMemory } from '../services/memory-service'
import { searchMemories } from '../search/hybrid'
import { buildContext } from '../services/context-service'
import { getLatestJob } from '../services/digest-service'

/**
 * MCP Streamable HTTP（无状态）端点。
 * 只实现 initialize / tools/list / tools/call / ping 四个方法；
 * 通知类请求（无 id）返回 202；不支持 server→client SSE 流（GET 返回 405）。
 * 工具 handler 与 REST 共享 service 层。
 */

const SERVER_INFO = { name: 'cabbage-memory', version: '2.0.0' }
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

// ── JSON-RPC 类型 ──

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResult {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface McpHttpResponse {
  status: number
  /** undefined 表示空 body（202） */
  body?: JsonRpcResult
}

// ── 工具定义 ──

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (env: Env, userId: string, args: Record<string, unknown>, ctx?: WaitContext) => Promise<unknown>
}

const stringEnum = (values: readonly string[]) => ({ type: 'string', enum: [...values] })

const TOOLS: ToolDef[] = [
  {
    name: 'memory_search',
    description:
      'Semantic + keyword hybrid search over memories. Full keyword matches are strictly ranked above partial matches (bucket tiering).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        type: { ...stringEnum(['daily', 'fact', 'instruction', 'digest']), description: 'Filter by memory type' },
        project_id: { type: 'string', description: 'Filter by project (owner/repo)' },
        topK: { type: 'number', description: 'Max results (default 8)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: (env, userId, args) =>
      searchMemories(env, {
        query: String(args.query || ''),
        userId,
        type: args.type as MemoryType | undefined,
        projectId: args.project_id ? String(args.project_id) : undefined,
        topK: args.topK ? Number(args.topK) : undefined,
      }),
  },
  {
    name: 'memory_add',
    description:
      'Create a memory record. Types: "daily" (raw log of what happened), "fact" (atomic long-term fact, use subtype preference/episodic/knowledge), "instruction" (stable rule/identity/workflow, use subtype identity/rule/workflow). One topic per record — split different aspects into separate records.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { ...stringEnum(['daily', 'fact', 'instruction']), description: 'Memory type (digest is system-generated)' },
        subtype: { type: 'string', description: 'instruction: identity|rule|workflow; fact: preference|episodic|knowledge' },
        title: { type: 'string', description: 'Short title (recommended for fact/instruction)' },
        content: { type: 'string', description: 'Memory content' },
        project_id: { type: 'string', description: 'Project scope (owner/repo). Empty = global' },
        date: { type: 'string', description: 'YYYY-MM-DD for daily records. Default: today' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['type', 'content'],
      additionalProperties: false,
    },
    handler: async (env, userId, args, ctx) =>
      createMemory(
        env,
        userId,
        {
          type: args.type as MemoryType,
          subtype: args.subtype ? String(args.subtype) : undefined,
          title: args.title ? String(args.title) : undefined,
          content: String(args.content || ''),
          project_id: args.project_id ? String(args.project_id) : undefined,
          date: args.date ? String(args.date) : undefined,
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
        },
        ctx,
      ),
  },
  {
    name: 'memory_get',
    description: 'Get a single memory record by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Memory id' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (env, userId, args) => {
      const record = await getMemory(env, userId, String(args.id || ''))
      if (!record) throw new McpError('NOT_FOUND', `memory ${args.id}`)
      return record
    },
  },
  {
    name: 'memory_update',
    description: 'Update title/content/tags of a memory record.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory id' },
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (env, userId, args, ctx) => {
      await updateMemory(
        env,
        userId,
        String(args.id || ''),
        {
          title: args.title !== undefined ? String(args.title) : undefined,
          content: args.content !== undefined ? String(args.content) : undefined,
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
        },
        ctx,
      )
      return { ok: true }
    },
  },
  {
    name: 'memory_delete',
    description: 'Delete a memory record by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Memory id' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (env, userId, args) => {
      await deleteMemory(env, userId, String(args.id || ''))
      return { ok: true }
    },
  },
  {
    name: 'memory_context',
    description: 'Get assembled memory context (identity, preferences, rules, project knowledge, recent digests) for system prompt injection.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: 'Current project (owner/repo)' } },
      additionalProperties: false,
    },
    handler: (env, userId, args) =>
      buildContext(env, userId, args.project_id ? String(args.project_id) : ''),
  },
  {
    name: 'memory_digest_status',
    description: 'Get latest daily digest cron job status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (env, userId) => getLatestJob(env, 'digest', userId),
  },
]

// ── JSON-RPC 分发 ──

export async function handleMcpPost(
  env: Env,
  ctx: WaitContext | undefined,
  userId: string,
  body: JsonRpcRequest,
): Promise<McpHttpResponse> {
  // 通知类请求（无 id）：不回响应，202 Accepted
  if (body.id === undefined || body.id === null) {
    return { status: 202 }
  }

  try {
    const result = await dispatch(env, ctx, userId, body)
    return { status: 200, body: { jsonrpc: '2.0', id: body.id, result } }
  } catch (error) {
    if (error instanceof McpError) {
      return {
        status: 200,
        body: { jsonrpc: '2.0', id: body.id, error: { code: error.code, message: error.message } },
      }
    }
    const message = error instanceof Error ? error.message : 'Internal error'
    console.error('[mcp] tool call failed:', message)
    return {
      status: 200,
      body: { jsonrpc: '2.0', id: body.id, error: { code: -32603, message } },
    }
  }
}

async function dispatch(
  env: Env,
  ctx: WaitContext | undefined,
  userId: string,
  req: JsonRpcRequest,
): Promise<unknown> {
  const params = req.params || {}

  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }
    case 'ping':
      return {}
    case 'tools/list':
      return {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      }
    case 'tools/call': {
      const name = String(params.name || '')
      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) throw new McpError('NOT_FOUND', `tool ${name}`)
      const args = (params.arguments || {}) as Record<string, unknown>
      try {
        const data = await tool.handler(env, userId, args, ctx)
        const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
        return {
          content: [{ type: 'text', text }],
          isError: false,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { content: [{ type: 'text', text: message }], isError: true }
      }
    }
    default:
      throw new McpError('NOT_FOUND', req.method)
  }
}
