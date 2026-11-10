import test from "node:test";
import assert from "node:assert/strict";
import { listMemories } from "../src/services/memory-service";
import { searchMemories, vectorCandidateIds } from "../src/search/hybrid";
import {
  projectFilterValues,
  projectScopeCondition,
} from "../src/search/scope";
import type { Env, MemoryRecord } from "../src/types";
import { createMockEnv, makeRecord } from "./helpers";

test("scope 条件：project 包含当前项目 + 全局，global 仅全局，all 不过滤", () => {
  assert.deepEqual(projectScopeCondition("project", "proj-a"), {
    sql: " AND (project_id = ? OR project_id = '')",
    bindings: ["proj-a"],
  });
  assert.deepEqual(projectScopeCondition("project", undefined), {
    sql: "",
    bindings: [],
  });
  assert.deepEqual(projectScopeCondition("global", "proj-a"), {
    sql: " AND project_id = ''",
    bindings: [],
  });
  assert.deepEqual(projectScopeCondition("all", "proj-a"), {
    sql: "",
    bindings: [],
  });
  assert.deepEqual(projectScopeCondition(undefined, "proj-a"), {
    sql: " AND project_id = ?",
    bindings: ["proj-a"],
  });
});

test("scope 向量过滤值：project 查两次，global 只查全局，all 不传 project", () => {
  assert.deepEqual(projectFilterValues("project", "proj-a"), ["proj-a", ""]);
  assert.deepEqual(projectFilterValues("global", "proj-a"), [""]);
  assert.deepEqual(projectFilterValues("all", "proj-a"), []);
  assert.deepEqual(projectFilterValues(undefined, "proj-a"), ["proj-a"]);
});

test("listMemories：project scope 生成项目 + 全局条件", async () => {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async all() {
                calls.push({ sql, args });
                return { results: [] };
              },
            };
          },
        };
      },
    } as unknown as Env["DB"],
  } as Env;

  await listMemories(env, "u-1", { scope: "project", project_id: "proj-a" });
  assert.match(calls[0].sql, /\(project_id = \? OR project_id = ''\)/);
  assert.ok(calls[0].args.includes("proj-a"));

  await listMemories(env, "u-1", { scope: "global", project_id: "proj-a" });
  assert.match(calls[1].sql, /project_id = ''/);
  assert.ok(!calls[1].args.includes("proj-a"));

  await listMemories(env, "u-1", { scope: "all", project_id: "proj-a" });
  assert.doesNotMatch(calls[2].sql, /project_id = \?/);
});

test("vectorCandidateIds：project scope 分两次查询并合并项目 + 全局结果", async () => {
  const filters: Record<string, string>[] = [];
  const env = createMockEnv({});
  (
    env.VEC as unknown as {
      query: (
        vector: number[],
        opts: { filter: Record<string, string> },
      ) => Promise<{ matches: Array<{ id: string; score: number }> }>;
    }
  ).query = async (_vector, opts) => {
    filters.push(opts.filter);
    if (opts.filter.project_id === "proj-a")
      return { matches: [{ id: "r-a", score: 0.9 }] };
    if (opts.filter.project_id === "")
      return { matches: [{ id: "r-global", score: 0.8 }] };
    return { matches: [] };
  };

  const ids = await vectorCandidateIds(env, {
    query: "fact",
    userId: "u-1",
    scope: "project",
    projectId: "proj-a",
    topK: 5,
  });

  assert.deepEqual(
    filters.map((f) => f.project_id),
    ["proj-a", ""],
  );
  assert.deepEqual(ids, ["r-a", "r-global"]);
});

const recordA = makeRecord({
  id: "r-a",
  project_id: "proj-a",
  content: "A 项目事实",
});
const recordGlobal = makeRecord({
  id: "r-global",
  project_id: "",
  content: "全局事实",
});
const recordB = makeRecord({
  id: "r-b",
  project_id: "proj-b",
  content: "B 项目事实",
});

function createScopeSearchEnv(records: MemoryRecord[], ftsSqls: string[]) {
  const env = createMockEnv({
    records,
    queryHandler: (sql, args) => {
      if (sql.includes("FROM memories_fts")) {
        ftsSqls.push(sql);
        const all = records.map((r) => ({ id: r.id, snippet: "", rank: 0 }));
        const pid = args[args.length - 2] as string;
        if (sql.includes("(project_id = ? OR project_id = '')")) {
          return all.filter((r) => {
            const rec = records.find((x) => x.id === r.id)!;
            return rec.project_id === pid || rec.project_id === "";
          });
        }
        if (sql.includes("project_id = ''")) {
          return all.filter(
            (r) => records.find((x) => x.id === r.id)!.project_id === "",
          );
        }
        if (sql.includes("project_id = ?")) {
          return all.filter(
            (r) => records.find((x) => x.id === r.id)!.project_id === pid,
          );
        }
        return all;
      }
      if (sql.includes("FROM memories") && sql.includes("id IN")) {
        const userIdx = args.indexOf("u-1");
        if (userIdx < 0) return [];
        const ids = args.slice(0, userIdx) as string[];
        let rows = records.filter(
          (r) => ids.includes(r.id) && r.archived === 0,
        );
        if (sql.includes("(project_id = ? OR project_id = '')")) {
          const pid = args[userIdx + 1] as string;
          rows = rows.filter(
            (r) => r.project_id === pid || r.project_id === "",
          );
        } else if (sql.includes("project_id = ''")) {
          rows = rows.filter((r) => r.project_id === "");
        } else if (sql.includes("project_id = ?")) {
          const pid = args[userIdx + 1] as string;
          rows = rows.filter((r) => r.project_id === pid);
        }
        return rows;
      }
      return [];
    },
  });
  (
    env.VEC as unknown as {
      query: (
        vector: number[],
        opts: { filter: Record<string, string> },
      ) => Promise<{ matches: Array<{ id: string; score: number }> }>;
    }
  ).query = async (_vector, opts) => {
    if (opts.filter.project_id === "proj-a")
      return { matches: [{ id: "r-a", score: 0.9 }] };
    if (opts.filter.project_id === "")
      return { matches: [{ id: "r-global", score: 0.8 }] };
    return { matches: [] };
  };
  return env;
}

test("searchMemories：project scope 同时召回当前项目与全局，排除其他项目", async () => {
  const ftsSqls: string[] = [];
  const env = createScopeSearchEnv([recordA, recordGlobal, recordB], ftsSqls);

  const results = await searchMemories(env, {
    query: "事实",
    userId: "u-1",
    scope: "project",
    projectId: "proj-a",
    topK: 10,
  });

  assert.deepEqual(results.map((r) => r.id).sort(), ["r-a", "r-global"]);
  assert.ok(ftsSqls.length > 0);
  assert.ok(
    ftsSqls.every((sql) => sql.includes("(project_id = ? OR project_id = '')")),
  );
});

test("searchMemories：global scope 只返回全局记忆", async () => {
  const ftsSqls: string[] = [];
  const env = createScopeSearchEnv([recordA, recordGlobal, recordB], ftsSqls);

  const results = await searchMemories(env, {
    query: "事实",
    userId: "u-1",
    scope: "global",
    projectId: "proj-a",
    topK: 10,
  });

  assert.deepEqual(
    results.map((r) => r.id),
    ["r-global"],
  );
  assert.ok(ftsSqls.every((sql) => sql.includes("project_id = ''")));
});
