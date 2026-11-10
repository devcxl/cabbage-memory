import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { loadConfig } from "./config/runtime.js";
import { MemoryClient } from "./client.js";
import { detectProject } from "./utils/projectDetector.js";
import { resolveProjectId } from "./utils/defaultProject.js";
import { MEMORY_AWARENESS_INSTRUCTIONS } from "./instructions.js";
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
 * OpenCode 记忆插件（v2，纯远程模式）。
 * - 会话开始时通过 /api/context 注入记忆上下文
 * - memory 工具：add / search / get / update / delete / list
 * - 追踪会话状态，空闲时提示更新 daily log
 */

/** 追踪会话中 memory 工具调用，用于空闲时提示更新 daily log */
interface SessionState {
  memoryOperations: number;
  lastDailyUpdate: boolean;
}

const sessionStates = new Map<string, SessionState>();

const FIRST_RUN_CONTEXT = `# Memory Context

Memory service is empty. On first run, ask the user a few questions (name, preferences, how they want the assistant to behave) and store the answers:
- \`memory add --type instruction --subtype identity --title "..." --content "..."\` for identity/behavior rules
- \`memory add --type fact --subtype preference --title "..." --content "..."\` for user preferences`;

export const MemoryPlugin: Plugin = async (_ctx: PluginInput) => {
  const config = loadConfig();
  const client = new MemoryClient({
    apiUrl: config.apiUrl,
    apiKey: config.apiKey,
  });
  const detectedProject = config.autoProject ? detectProject() : null;

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      const projectId = resolveProjectId(undefined, detectedProject);
      let context = "";
      try {
        context = await client.context(projectId || undefined);
      } catch (error) {
        // 上下文获取失败不阻断会话，仅记录
        console.error(
          "[cabbage-memory] context fetch failed:",
          error instanceof Error ? error.message : error,
        );
        return;
      }
      const body = context || FIRST_RUN_CONTEXT;
      output.system.push(body + MEMORY_AWARENESS_INSTRUCTIONS);
    },

    event: async ({ event }) => {
      const sessionID =
        event.type === "session.idle"
          ? event.properties.sessionID
          : event.type === "session.created" || event.type === "session.deleted"
            ? event.properties.info.id
            : undefined;

      if (event.type === "session.created" && sessionID) {
        sessionStates.set(sessionID, {
          memoryOperations: 0,
          lastDailyUpdate: false,
        });
      }
      if (event.type === "session.deleted" && sessionID) {
        sessionStates.delete(sessionID);
      }
      if (event.type === "session.idle" && sessionID) {
        const state = sessionStates.get(sessionID);
        if (state && state.memoryOperations > 0 && !state.lastDailyUpdate) {
          await _ctx.client.tui.showToast({
            body: {
              message:
                "Tip: record today's work with memory add --type daily --content '...'",
              variant: "info",
            },
          });
        }
      }
    },

    "tool.execute.after": async (input) => {
      if (input.tool !== "memory") return;
      const state = sessionStates.get(input.sessionID);
      if (!state) return;
      state.memoryOperations++;
      const args = input.args as ToolArgs;
      if (args?.type === "daily") state.lastDailyUpdate = true;
    },

    tool: {
      memory: tool({
        description: [
          "Manage persistent memories in a remote memory service.",
          "",
          "**Actions:**",
          "- `add`: Create a record. `type`: daily (task log, DEFAULT for summaries) | fact (reusable knowledge, set subtype+title) | instruction (rules/identity/workflow).",
          "- `search`: Hybrid semantic + keyword search. Exact keyword matches rank first.",
          "- `get`: Read one record by id.",
          "- `update`: Update title/content/tags by id.",
          "- `delete`: Delete one record by id.",
          "- `list`: Recent records grouped by type. Use `date` for a specific day's daily log.",
          "",
          "**Rules:**",
          "- One topic per record. Split different regions/projects/subjects into separate records.",
          "- Put distinctive terms (region, project, tech) into title and content.",
          "- Use `scope: global` for cross-project knowledge; project scope is auto-detected otherwise.",
        ].join("\n"),
        args: {
          action: tool.schema
            .enum(["add", "search", "get", "update", "delete", "list"])
            .describe("Action to perform"),
          type: tool.schema
            .enum(["daily", "fact", "instruction"])
            .optional()
            .describe("Record type for add/list (digest is system-generated)"),
          subtype: tool.schema
            .enum([
              "identity",
              "rule",
              "workflow",
              "preference",
              "episodic",
              "knowledge",
            ])
            .optional()
            .describe(
              "instruction: identity/rule/workflow; fact: preference/episodic/knowledge",
            ),
          title: tool.schema
            .string()
            .optional()
            .describe(
              "Short title (required for fact, recommended for instruction)",
            ),
          content: tool.schema.string().optional().describe("Record content"),
          id: tool.schema
            .string()
            .optional()
            .describe("Record id (get/update/delete)"),
          query: tool.schema
            .string()
            .optional()
            .describe("Search query (search action)"),
          max_results: tool.schema
            .number()
            .optional()
            .describe("Max results (search/list, default 8/50)"),
          date: tool.schema
            .string()
            .optional()
            .describe("Date YYYY-MM-DD (daily log for a specific day)"),
          tags: tool.schema
            .string()
            .optional()
            .describe("Comma-separated tags"),
          scope: tool.schema
            .enum(["global", "project", "all"])
            .optional()
            .describe(
              "Scope: project = current project + global (default), global = global only, all = all projects (search/list)",
            ),
        },
        async execute(args) {
          const projectId = resolveProjectId(
            args.scope === "all" ? undefined : args.scope,
            detectedProject,
          );
          try {
            switch (args.action) {
              case "add":
                return await handleAdd(client, args, projectId);
              case "search":
                return await handleSearch(client, args, projectId);
              case "get":
                return await handleGet(client, args);
              case "update":
                return await handleUpdate(client, args);
              case "delete":
                return await handleDelete(client, args);
              case "list":
                return await handleList(client, args, projectId);
              default:
                return `Unknown action: ${args.action}`;
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            return `Error: ${message}`;
          }
        },
      }),
    },
  };
};

export default MemoryPlugin;
