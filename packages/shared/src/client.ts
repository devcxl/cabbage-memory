import type { MemoryRecord } from "./schema";
import type {
  ApiResponse,
  ContextResponse,
  CreateMemoryInput,
  ListMemoriesQuery,
  SearchRequest,
  SearchResult,
  Stats,
  UpdateMemoryInput,
} from "./api";

/** 远程 Worker 配置 */
export interface RemoteConfig {
  apiUrl: string;
  apiKey: string;
}

/**
 * Worker REST API 薄客户端（OpenCode 插件 / pi 扩展共用）。
 * 网络/认证错误抛异常；业务错误（success:false）也抛异常，
 * 让调用方统一走错误格式化路径。
 */
export class MemoryClient {
  constructor(private config: RemoteConfig) {}

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.config.apiUrl}${path}`, {
      ...init,
      headers: {
        ...this.headers,
        ...(init?.headers as Record<string, string>),
      },
    });
    const body = (await res.json().catch(() => ({}))) as ApiResponse<T>;
    if (!res.ok || !body.success) {
      throw new Error(
        `Memory API ${res.status}: ${body.error || res.statusText}`,
      );
    }
    return body.data as T;
  }

  private async query<T>(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<T> {
    const url = new URL(`${this.config.apiUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "")
        url.searchParams.set(key, String(value));
    }
    const res = await fetch(url.toString(), {
      headers: { Authorization: this.headers.Authorization },
    });
    const body = (await res.json().catch(() => ({}))) as ApiResponse<T>;
    if (!res.ok || !body.success) {
      throw new Error(
        `Memory API ${res.status}: ${body.error || res.statusText}`,
      );
    }
    return body.data as T;
  }

  /** POST /api/memories — 创建记录（向量索引与 fact 后处理由服务端异步完成） */
  async create(input: CreateMemoryInput): Promise<{ id: string }> {
    return this.request("/api/memories", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** GET /api/memories — 列出记录 */
  async list(query: ListMemoriesQuery = {}): Promise<MemoryRecord[]> {
    return this.query("/api/memories", {
      type: query.type,
      subtype: query.subtype,
      scope: query.scope,
      project_id: query.project_id,
      date: query.date,
      limit: query.limit,
      offset: query.offset,
    });
  }

  /** GET /api/memories/:id */
  async get(id: string): Promise<MemoryRecord> {
    return this.request(`/api/memories/${encodeURIComponent(id)}`);
  }

  /** PUT /api/memories/:id */
  async update(id: string, input: UpdateMemoryInput): Promise<void> {
    await this.request(`/api/memories/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  /** DELETE /api/memories/:id */
  async delete(id: string): Promise<void> {
    await this.request(`/api/memories/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  /** POST /api/memories/search — 两桶分层混合搜索 */
  async search(req: SearchRequest): Promise<SearchResult[]> {
    return this.request("/api/memories/search", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  /** GET /api/context — 组装好的上下文 Markdown */
  async context(projectId?: string): Promise<string> {
    const data = await this.query<ContextResponse>("/api/context", {
      project_id: projectId,
    });
    return data.context || "";
  }

  /** GET /api/stats — 统计概览 */
  async stats(): Promise<Stats> {
    return this.query("/api/stats", {});
  }
}
