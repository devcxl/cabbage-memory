import type { MemoryQueryScope, MemoryType } from "./schema";

/** Worker API 统一响应格式 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** 搜索结果（两桶分层 + RRF 融合后） */
export interface SearchResult {
  id: string;
  type: MemoryType;
  subtype: string;
  title: string;
  content: string;
  tags: string;
  project_id: string;
  date: string;
  created_at: number;
  /** 归属桶：full-match（FTS 全命中，确定性优先）| fused（其余候选） */
  bucket: "full-match" | "fused";
  /** RRF 融合评分 */
  score: number;
  /** FTS 命中的上下文片段（仅 FTS 命中记录有值） */
  snippet: string;
}

/** RAG 引用 */
export interface RagCitation {
  memoryId: string;
  text: string;
  createdAt: number;
  type: MemoryType;
  score: number;
}

/** /api/ask 响应 */
export interface AskResponse {
  answer: string;
  citations: RagCitation[];
}

/** /api/context 响应：组装好的上下文 Markdown（供插件注入 system prompt） */
export interface ContextResponse {
  context: string;
}

export interface Stats {
  total: number;
  byType: Record<MemoryType, number>;
  projectCount: number;
  /** 待 digest 的 daily 数（未消费） */
  undigestedCount: number;
}

/** POST /api/memories 请求体 */
export interface CreateMemoryInput {
  type: MemoryType;
  subtype?: string;
  title?: string;
  content: string;
  scope?: "global" | "project";
  project_id?: string;
  date?: string;
  tags?: string[];
}

/** PUT /api/memories/:id 请求体 */
export interface UpdateMemoryInput {
  title?: string;
  content?: string;
  tags?: string[];
  project_id?: string;
}

/** GET /api/memories 查询参数 */
export interface ListMemoriesQuery {
  type?: MemoryType;
  subtype?: string;
  scope?: MemoryQueryScope;
  project_id?: string;
  date?: string;
  limit?: number;
  offset?: number;
}

/** POST /api/memories/search 请求体 */
export interface SearchRequest {
  query: string;
  topK?: number;
  type?: MemoryType;
  scope?: MemoryQueryScope;
  project_id?: string;
  /** 分面硬过滤，如 { region: '华北' }（可选，第二阶段查询解析产出） */
  facets?: Record<string, string>;
}
