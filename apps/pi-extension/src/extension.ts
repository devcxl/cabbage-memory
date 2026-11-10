import { pi } from "@mariozechner/pi-coding-agent";
import { MemoryClient } from "@devcxl/cabbage-memory-shared";
import { loadPiConfig } from "./config.js";
import { detectProject } from "./project.js";
import {
  handleAdd,
  handleSearch,
  handleGet,
  handleUpdate,
  handleDelete,
  handleList,
  type ToolArgs,
} from "./handlers.js";

/**
 * cabbage-memory 的 pi 扩展。
 * pi 不支持 MCP（官方设计决策），因此以原生 TypeScript 扩展接入：
 * - registerTool：memory 工具（add/search/get/update/delete/list）
 * - on("before_agent_start")：注入服务端组装的记忆上下文 + 使用说明
 *
 * 安装：`pi -e <本文件路径>`，或复制到 ~/.pi/agent/extensions/。
 */

const FIRST_RUN_CONTEXT = `# Memory Context

Memory service is empty. On first run, ask the user a few questions (name, preferences, how they want the assistant to behave) and store the answers:
- memory add with type "instruction" / subtype "identity" for identity & behavior rules
- memory add with type "fact" / subtype "preference" for user preferences`;

const MEMORY_INSTRUCTIONS = `

# Memory Usage

You have a persistent memory service. Use the \`memory\` tool to record and retrieve context across sessions.

## Actions
- \`add\` — create a record:
  - \`type: "daily"\`: task log / what happened today. One entry per call; set \`date\` (YYYY-MM-DD) for a specific day.
  - \`type: "fact"\`: reusable knowledge, preferences, decisions. ALWAYS set a short \`title\` and \`subtype\` (preference | episodic | knowledge).
  - \`type: "instruction"\`: stable rules, workflows, identity. Set \`subtype\` (identity | rule | workflow).
- \`search\` — hybrid (semantic + keyword) search. Exact keyword matches rank above partial matches, so put distinctive terms in queries.
- \`get\` / \`update\` / \`delete\` — operate on one record by \`id\`.
- \`list\` — recent records grouped by type; use \`date\` to fetch a specific day's daily log.

## Guidelines
1. DEFAULT to \`daily\` for task summaries. Use \`fact\` for knowledge worth reusing in future sessions.
2. Facts must be atomic: one topic per record. If content covers two regions/projects/subjects, write separate records.
3. Put high-distinction terms (region, project name, tech stack, person) into both title and content.
4. Check \`search\` before writing a fact that might already exist; prefer \`update\` over duplicating.
5. Scope: writes default to the detected project; \`scope: "global"\` forces global-only. Search/list default to project scope and include global knowledge; use \`all\` to search every project.
`;

const config = loadPiConfig();
const client = new MemoryClient({
  apiUrl: config.apiUrl,
  apiKey: config.apiKey,
});
const detectedProject = config.autoProject ? detectProject() : null;

// ── 工具参数 schema（JSON Schema，与服务端 MCP 工具同一套形状） ──

const typeSchema = {
  type: "string",
  enum: ["daily", "fact", "instruction"],
  description: "Memory type for add/list (digest is system-generated)",
} as const;

const subtypeSchema = {
  type: "string",
  enum: ["identity", "rule", "workflow", "preference", "episodic", "knowledge"],
  description:
    "instruction: identity/rule/workflow; fact: preference/episodic/knowledge",
} as const;

const scopeSchema = {
  type: "string",
  enum: ["global", "project", "all"],
  description:
    "Scope: project = current project + global (default), global = global only, all = all projects (search/list)",
} as const;

const addParams = {
  type: "object",
  properties: {
    type: typeSchema,
    subtype: subtypeSchema,
    title: {
      type: "string",
      description:
        "Short title (required for fact, recommended for instruction)",
    },
    content: { type: "string", description: "Record content" },
    date: {
      type: "string",
      description: "YYYY-MM-DD for daily records. Default: today",
    },
    tags: { type: "string", description: "Comma-separated tags" },
    scope: scopeSchema,
  },
  required: ["type", "content"],
  additionalProperties: false,
} as const;

const searchParams = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query" },
    max_results: { type: "number", description: "Max results (default 8)" },
    scope: scopeSchema,
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const idParams = {
  type: "object",
  properties: { id: { type: "string", description: "Record id" } },
  required: ["id"],
  additionalProperties: false,
} as const;

const updateParams = {
  type: "object",
  properties: {
    id: { type: "string", description: "Record id" },
    title: { type: "string" },
    content: { type: "string" },
    tags: { type: "string", description: "Comma-separated tags" },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

const listParams = {
  type: "object",
  properties: {
    type: typeSchema,
    date: {
      type: "string",
      description: "YYYY-MM-DD (a specific day's daily log)",
    },
    max_results: { type: "number", description: "Max records (default 50)" },
    scope: scopeSchema,
  },
  additionalProperties: false,
} as const;

// ── 工具注册 ──

function wrap(fn: (args: ToolArgs) => Promise<string>) {
  return async (_toolCallId: string, params: ToolArgs) => {
    try {
      const text = await fn(params);
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
}

pi.registerTool({
  name: "memory_add",
  label: "memory.add",
  description:
    'Create a memory record. Types: "daily" (task log, DEFAULT for summaries), "fact" (reusable knowledge, set subtype+title), "instruction" (stable rules/identity/workflow). One topic per record.',
  parameters: addParams,
  execute: wrap((args) => handleAdd(client, args, detectedProject)),
});

pi.registerTool({
  name: "memory_search",
  label: "memory.search",
  description:
    "Hybrid semantic + keyword search over memories. Exact keyword matches rank above partial matches.",
  parameters: searchParams,
  execute: wrap((args) => handleSearch(client, args, detectedProject)),
});

pi.registerTool({
  name: "memory_get",
  label: "memory.get",
  description: "Get a single memory record by id.",
  parameters: idParams,
  execute: wrap((args) => handleGet(client, args)),
});

pi.registerTool({
  name: "memory_update",
  label: "memory.update",
  description: "Update title/content/tags of a memory record.",
  parameters: updateParams,
  execute: wrap((args) => handleUpdate(client, args)),
});

pi.registerTool({
  name: "memory_delete",
  label: "memory.delete",
  description: "Delete a memory record by id.",
  parameters: idParams,
  execute: wrap((args) => handleDelete(client, args)),
});

pi.registerTool({
  name: "memory_list",
  label: "memory.list",
  description:
    "List recent memory records grouped by type. Use date to fetch a specific day's daily log.",
  parameters: listParams,
  execute: wrap((args) => handleList(client, args, detectedProject)),
});

// ── 上下文注入：服务端 /api/context 组装，失败不阻断会话 ──

pi.on("before_agent_start", async (event) => {
  let context = "";
  try {
    context = await client.context(detectedProject || undefined);
  } catch (error) {
    console.error(
      "[cabbage-memory-pi] context fetch failed:",
      error instanceof Error ? error.message : error,
    );
    return;
  }
  const body = context || FIRST_RUN_CONTEXT;
  return { systemPrompt: event.systemPrompt + body + MEMORY_INSTRUCTIONS };
});
