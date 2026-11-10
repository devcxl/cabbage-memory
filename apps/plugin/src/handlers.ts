import type { MemoryClient } from "./client.js";
import type {
  MemoryQueryScope,
  MemoryType,
} from "@devcxl/cabbage-memory-shared";

/** 工具入参（OpenCode tool.schema 校验后的形状） */
export interface ToolArgs {
  action?: string;
  type?: MemoryType;
  subtype?: string;
  title?: string;
  content?: string;
  id?: string;
  query?: string;
  max_results?: number;
  date?: string;
  tags?: string;
  scope?: MemoryQueryScope;
  project_id?: string;
}

const SUBTYPES = new Set([
  "identity",
  "rule",
  "workflow",
  "preference",
  "episodic",
  "knowledge",
]);

function fmtRecord(r: {
  id: string;
  type: string;
  subtype: string;
  title: string;
  content: string;
  project_id: string;
  date: string;
  created_at: number;
}): string {
  const parts = [
    `[${r.id}]`,
    `type: ${r.type}${r.subtype ? `/${r.subtype}` : ""}`,
    r.project_id ? `project: ${r.project_id}` : "project: (global)",
    r.date ? `date: ${r.date}` : "",
    `created: ${new Date(r.created_at).toISOString().replace("T", " ").slice(0, 16)}`,
  ].filter(Boolean);
  const heading = r.title ? `${r.title}\n` : "";
  return `${parts.join(" | ")}\n${heading}${r.content}`;
}

function parseTags(tags: string | undefined): string[] | undefined {
  if (!tags) return undefined;
  const list = tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function validateSubtypeForType(
  type: MemoryType,
  subtype?: string,
): string | undefined {
  if (!subtype) return undefined;
  if (!SUBTYPES.has(subtype)) throw new Error(`Invalid subtype: ${subtype}`);
  if (
    type === "instruction" &&
    ["identity", "rule", "workflow"].includes(subtype)
  )
    return subtype;
  if (
    type === "fact" &&
    ["preference", "episodic", "knowledge"].includes(subtype)
  )
    return subtype;
  throw new Error(`subtype "${subtype}" is not valid for type "${type}"`);
}

/** add — 创建记录 */
export async function handleAdd(
  client: MemoryClient,
  args: ToolArgs,
  projectId: string | null,
): Promise<string> {
  if (!args.content) return "Error: content is required for add action.";
  if (!args.type)
    return "Error: type is required for add action (daily | fact | instruction).";

  const type = args.type;
  const subtype = validateSubtypeForType(type, args.subtype);
  // scope=global 必须覆盖 project_id / 自动探测结果；其余情况写入当前项目（与 pi 扩展一致）
  const effectiveProject =
    args.scope === "global" ? null : (args.project_id ?? projectId);

  const { id } = await client.create({
    type,
    subtype,
    title: args.title,
    content: args.content,
    project_id: effectiveProject || undefined,
    date: args.date,
    tags: parseTags(args.tags),
  });

  const scopeTag = effectiveProject ? `project/${effectiveProject}` : "global";
  return [
    `Added ${type}${subtype ? `/${subtype}` : ""} record ${id} (scope: ${scopeTag}).`,
    type === "fact"
      ? "Server will index it and check for conflicts/duplicates in the background."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** search — 两桶分层混合搜索 */
export async function handleSearch(
  client: MemoryClient,
  args: ToolArgs,
  projectId: string | null,
): Promise<string> {
  if (!args.query) return "Error: query is required for search action.";

  // project = 当前项目 + 全局（默认）；global = 仅全局；all = 全部项目
  const scope: MemoryQueryScope =
    args.scope === "global" || args.scope === "all"
      ? args.scope
      : projectId
        ? "project"
        : "all";

  const results = await client.search({
    query: args.query,
    topK: args.max_results,
    scope,
    project_id: scope === "project" ? projectId || undefined : undefined,
  });

  if (results.length === 0) return `No memories found for "${args.query}".`;

  return [
    `Found ${results.length} memories (exact matches ranked first):`,
    "",
    ...results.map(
      (r, i) =>
        `${i + 1}. [${r.id}] ${r.type}${r.subtype ? `/${r.subtype}` : ""} bucket=${r.bucket}${r.date ? ` date=${r.date}` : ""}\n${r.title ? `${r.title}\n` : ""}${r.content}`,
    ),
  ].join("\n");
}

/** get — 读取单条 */
export async function handleGet(
  client: MemoryClient,
  args: ToolArgs,
): Promise<string> {
  if (!args.id) return "Error: id is required for get action.";
  const record = await client.get(args.id);
  return fmtRecord(record);
}

/** update — 更新单条 */
export async function handleUpdate(
  client: MemoryClient,
  args: ToolArgs,
): Promise<string> {
  if (!args.id) return "Error: id is required for update action.";
  if (!args.title && !args.content && !args.tags) {
    return "Error: provide at least one of title / content / tags for update action.";
  }
  await client.update(args.id, {
    title: args.title,
    content: args.content,
    tags: parseTags(args.tags),
  });
  return `Updated record ${args.id}.`;
}

/** delete — 删除单条 */
export async function handleDelete(
  client: MemoryClient,
  args: ToolArgs,
): Promise<string> {
  if (!args.id) return "Error: id is required for delete action.";
  await client.delete(args.id);
  return `Deleted record ${args.id}.`;
}

/** list — 按类型分组列出最近记录 */
export async function handleList(
  client: MemoryClient,
  args: ToolArgs,
  projectId: string | null,
): Promise<string> {
  const limit = Math.min(args.max_results || 50, 200);
  const scope: MemoryQueryScope =
    args.scope === "global" || args.scope === "all"
      ? args.scope
      : projectId
        ? "project"
        : "all";
  const records = await client.list({
    type: args.type,
    scope,
    project_id: scope === "project" ? projectId || undefined : undefined,
    date: args.date,
    limit,
  });

  if (records.length === 0) return "No memories found.";

  const byType = new Map<string, typeof records>();
  for (const r of records) {
    const key =
      r.type === "daily" ? `daily${r.date ? ` (${r.date})` : ""}` : r.type;
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key)!.push(r);
  }

  const sections: string[] = [`Total ${records.length} records:`];
  for (const [type, group] of byType) {
    sections.push(`\n## ${type} (${group.length})`);
    sections.push(
      group
        .map(
          (r) =>
            `- [${r.id}] ${r.title ? `${r.title}: ` : ""}${r.content.slice(0, 120)}${r.content.length > 120 ? "..." : ""}`,
        )
        .join("\n"),
    );
  }
  return sections.join("\n");
}
