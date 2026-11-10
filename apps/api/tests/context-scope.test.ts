import test from "node:test";
import assert from "node:assert/strict";
import { buildContext } from "../src/services/context-service";
import { createMockEnv } from "./helpers";

interface ContextRow {
  user_id: string;
  type: string;
  subtype: string;
  title: string;
  content: string;
  project_id: string;
  archived: number;
  created_at: number;
}

const rows: ContextRow[] = [
  {
    user_id: "u-1",
    type: "instruction",
    subtype: "rule",
    title: "Global Rule",
    content: "全局规则",
    project_id: "",
    archived: 0,
    created_at: 1,
  },
  {
    user_id: "u-1",
    type: "instruction",
    subtype: "rule",
    title: "A Rule",
    content: "A项目规则",
    project_id: "proj-a",
    archived: 0,
    created_at: 2,
  },
  {
    user_id: "u-1",
    type: "instruction",
    subtype: "rule",
    title: "B Rule",
    content: "B项目规则",
    project_id: "proj-b",
    archived: 0,
    created_at: 3,
  },
  {
    user_id: "u-1",
    type: "fact",
    subtype: "knowledge",
    title: "Global Fact",
    content: "全局事实",
    project_id: "",
    archived: 0,
    created_at: 4,
  },
  {
    user_id: "u-1",
    type: "fact",
    subtype: "knowledge",
    title: "A Fact",
    content: "A项目事实",
    project_id: "proj-a",
    archived: 0,
    created_at: 5,
  },
  {
    user_id: "u-1",
    type: "fact",
    subtype: "knowledge",
    title: "B Fact",
    content: "B项目事实",
    project_id: "proj-b",
    archived: 0,
    created_at: 6,
  },
];

/** 按 SQL 里实际出现的项目过滤条件返回结果，未加过滤时暴露跨项目数据 */
function contextQuery(sql: string, args: unknown[]): unknown[] | undefined {
  if (sql.includes("subtype IN ('rule', 'workflow')")) {
    const userId = args[0] as string;
    const projectFiltered = sql.includes("(project_id = ? OR project_id = '')");
    const projectId = projectFiltered ? (args[1] as string) : "";
    return rows.filter((r) => {
      if (r.user_id !== userId || r.type !== "instruction") return false;
      if (!["rule", "workflow"].includes(r.subtype)) return false;
      if (!projectFiltered) return true;
      return r.project_id === projectId || r.project_id === "";
    });
  }

  if (sql.includes("type = 'fact'") && sql.includes("project_id = ?")) {
    const userId = args[0] as string;
    const projectId = args[1] as string;
    const includeGlobal = sql.includes("OR project_id = ''");
    return rows.filter((r) => {
      if (r.user_id !== userId || r.type !== "fact") return false;
      return (
        r.project_id === projectId || (includeGlobal && r.project_id === "")
      );
    });
  }

  return [];
}

test("H2：项目上下文只注入本项目和全局规则", async () => {
  const env = createMockEnv({ queryHandler: contextQuery });
  const context = await buildContext(env, "u-1", "proj-a");

  assert.match(context, /全局规则/);
  assert.match(context, /A项目规则/);
  assert.doesNotMatch(context, /B项目规则/);
});

test("H2：项目知识包含当前项目和全局 fact，并标注全局来源", async () => {
  const env = createMockEnv({ queryHandler: contextQuery });
  const context = await buildContext(env, "u-1", "proj-a");

  assert.match(context, /A项目事实/);
  assert.match(context, /全局事实/);
  assert.doesNotMatch(context, /B项目事实/);
  assert.match(context, /\(global\)/);
});

test("H2：项目 B 不会拿到项目 A 的规则和事实", async () => {
  const env = createMockEnv({ queryHandler: contextQuery });
  const context = await buildContext(env, "u-1", "proj-b");

  assert.match(context, /B项目规则/);
  assert.match(context, /B项目事实/);
  assert.match(context, /全局事实/);
  assert.doesNotMatch(context, /A项目规则/);
  assert.doesNotMatch(context, /A项目事实/);
});
