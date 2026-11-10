import type { MemoryQueryScope } from "@devcxl/cabbage-memory-shared";

/**
 * 查询作用域的统一语义（FTS / 向量 / hydrate / list 共用）：
 * - project：当前项目 + 全局（project_id = pid OR project_id = ''）
 * - global：仅全局（project_id = ''）
 * - all：不过滤项目
 * - 未传 scope 且传了 project_id：保持旧 API 语义，精确匹配该项目
 */
export function projectScopeCondition(
  scope: MemoryQueryScope | undefined,
  projectId: string | undefined,
  column = "project_id",
): { sql: string; bindings: string[] } {
  if (scope === "project") {
    if (!projectId) return { sql: "", bindings: [] };
    return {
      sql: ` AND (${column} = ? OR ${column} = '')`,
      bindings: [projectId],
    };
  }
  if (scope === "global") {
    return { sql: ` AND ${column} = ''`, bindings: [] };
  }
  if (!scope && projectId) {
    return { sql: ` AND ${column} = ?`, bindings: [projectId] };
  }
  return { sql: "", bindings: [] };
}

/**
 * 向量检索的 project 过滤值：
 * - project：当前项目 + 全局，两次查询
 * - global：仅全局，一次查询
 * - all：无 project 过滤
 * - 未传 scope 且传了 project_id：精确该项目（旧语义）
 */
export function projectFilterValues(
  scope: MemoryQueryScope | undefined,
  projectId: string | undefined,
): string[] {
  if (scope === "project") {
    return projectId ? [projectId, ""] : [];
  }
  if (scope === "global") return [""];
  if (!scope && projectId) return [projectId];
  return [];
}
