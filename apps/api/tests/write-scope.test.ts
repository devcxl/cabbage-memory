import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemory,
  normalizeScope,
  updateMemory,
} from "../src/services/memory-service";
import type { Env, MemoryRecord } from "../src/types";
import { makeRecord } from "./helpers";

function createWriteEnv(existing?: MemoryRecord) {
  const inserts: unknown[][] = [];
  const updates: unknown[][] = [];

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.includes("INSERT INTO memories")) inserts.push(args);
              if (sql.includes("UPDATE memories SET title")) updates.push(args);
              return { meta: { changes: 1 } };
            },
            async first<T>() {
              if (sql.includes("FROM memories WHERE id = ?"))
                return (existing ?? null) as T;
              return null as T;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  };

  const env = { DB: db as unknown as Env["DB"] } as Env;
  return { env, inserts, updates };
}

test("C2 normalizeScope：global 清空 project_id，project 必须有 project_id", () => {
  assert.deepEqual(normalizeScope("global", "proj-a"), {
    scope: "global",
    project_id: "",
  });
  assert.deepEqual(normalizeScope("project", "proj-a"), {
    scope: "project",
    project_id: "proj-a",
  });
  assert.deepEqual(normalizeScope(undefined, "proj-a"), {
    scope: "project",
    project_id: "proj-a",
  });
  assert.deepEqual(normalizeScope(undefined, ""), {
    scope: "global",
    project_id: "",
  });
  assert.throws(
    () => normalizeScope("project", "  "),
    /project scope requires project_id/,
  );
});

test("C2 createMemory：scope=global 时 project_id 落库为空", async () => {
  const { env, inserts } = createWriteEnv();

  await createMemory(env, "u-1", {
    type: "fact",
    subtype: "knowledge",
    content: "全局事实",
    scope: "global",
    project_id: "proj-a",
  });

  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][7], "global");
  assert.equal(inserts[0][8], "");
});

test("C2 createMemory：project scope 缺 project_id 直接拒绝，不写库", async () => {
  const { env, inserts } = createWriteEnv();

  await assert.rejects(
    createMemory(env, "u-1", {
      type: "fact",
      subtype: "knowledge",
      content: "项目事实",
      scope: "project",
    }),
    /project scope requires project_id/,
  );
  assert.equal(inserts.length, 0);
});

test("C2 createMemory：project scope 保留 project_id", async () => {
  const { env, inserts } = createWriteEnv();

  await createMemory(env, "u-1", {
    type: "fact",
    subtype: "knowledge",
    content: "项目事实",
    scope: "project",
    project_id: "proj-a",
  });

  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][7], "project");
  assert.equal(inserts[0][8], "proj-a");
});

test("C2 createMemory：digest 类型拒绝", async () => {
  const { env, inserts } = createWriteEnv();

  await assert.rejects(
    createMemory(env, "u-1", { type: "digest", content: "x" }),
    /digest type is system-generated/,
  );
  assert.equal(inserts.length, 0);
});

test("C2 updateMemory：项目记录改为全局时 scope 归一", async () => {
  const existing = makeRecord({
    id: "m-1",
    project_id: "proj-a",
    scope: "project",
  });
  const { env, updates } = createWriteEnv(existing);

  await updateMemory(env, "u-1", "m-1", { project_id: "" });

  assert.equal(updates.length, 1);
  assert.equal(updates[0][4], "");
  assert.equal(updates[0][5], "global");
});

test("C2 updateMemory：全局记录改为项目时 scope 归一", async () => {
  const existing = makeRecord({ id: "m-1", project_id: "", scope: "global" });
  const { env, updates } = createWriteEnv(existing);

  await updateMemory(env, "u-1", "m-1", { project_id: "proj-b" });

  assert.equal(updates.length, 1);
  assert.equal(updates[0][4], "proj-b");
  assert.equal(updates[0][5], "project");
});

test('C2 createMemory：global 写入的向量元数据 project_id 也为空', async () => {
  const { env } = createWriteEnv()
  const upserts: Array<{ id: string; metadata: Record<string, string | number> }> = []
  const waits: Promise<unknown>[] = []
  const envWithVector = {
    ...env,
    AI: {
      async run() {
        return { data: [[0.1]] }
      },
    },
    VEC: {
      async upsert(items: Array<{ id: string; metadata: Record<string, string | number> }>) {
        upserts.push(...items)
      },
    },
  } as unknown as Env

  await createMemory(
    envWithVector,
    'u-1',
    {
      type: 'instruction',
      subtype: 'rule',
      content: '全局规则',
      scope: 'global',
      project_id: 'proj-a',
    },
    { waitUntil: (promise) => waits.push(promise) },
  )
  await Promise.all(waits)

  assert.equal(upserts.length, 1)
  assert.equal(upserts[0].metadata.project_id, '')
})
