import test from "node:test";
import assert from "node:assert/strict";
import { reindexAll } from "../src/search/indexing";
import { segmentForIndex } from "../src/search/tokenizer";
import { EMBEDDING_MODEL } from "../src/types";
import type { Env, MemoryRecord } from "../src/types";
import { makeRecord } from "./helpers";

interface RecordedUpdate {
  sql: string;
  args: unknown[];
}

/** 最小 D1 mock：支持 reindex 的 SELECT、content_fts UPDATE、meta UPDATE 与 batch */
function createReindexEnv(rows: MemoryRecord[]) {
  const updates: RecordedUpdate[] = [];

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all<T>() {
              if (sql.includes("SELECT * FROM memories"))
                return { results: rows as T[] };
              return { results: [] as T[] };
            },
            async first<T>() {
              return null as T;
            },
            async run() {
              updates.push({ sql, args });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      for (const statement of statements) await statement.run();
      return [];
    },
  };

  const env = {
    DB: db as unknown as Env["DB"],
    VEC: {
      async upsert() {},
      async deleteByIds() {},
    } as unknown as Env["VEC"],
    AI: {
      async run(_model: string, input: { text?: unknown }) {
        const count = Array.isArray(input.text) ? input.text.length : 1;
        return { data: Array.from({ length: count }, () => [0.1, 0.2]) };
      },
    } as unknown as Env["AI"],
    JWT_SECRET: "test",
    TZ_OFFSET_HOURS: "8",
  } as Env;

  return { env, updates };
}

test("H1：reindex 会为迁移后 content_fts 为空的记录重建 FTS", async () => {
  const row = makeRecord({
    id: "m-1",
    type: "instruction",
    subtype: "rule",
    title: "端口约定",
    content: "项目统一使用 5432 端口",
    content_fts: "",
  });
  const { env, updates } = createReindexEnv([row]);

  const result = await reindexAll(env, "u-1", { force: true });

  assert.equal(result.ftsUpdated, 1);
  const ftsUpdate = updates.find((u) =>
    u.sql.startsWith("UPDATE memories SET content_fts"),
  );
  assert.ok(ftsUpdate, "expected a content_fts update");
  const fts = String(ftsUpdate.args[0]);
  assert.match(fts, /端 口/);
  assert.match(fts, /5432/);
});

test("H1：向量已是最新版本时仍会重建 FTS", async () => {
  const row = makeRecord({
    id: "m-2",
    type: "instruction",
    subtype: "rule",
    title: "规则",
    content: "必须使用 pnpm",
    content_fts: "",
    meta: JSON.stringify({ vector_model: EMBEDDING_MODEL }),
  });
  const { env } = createReindexEnv([row]);

  const result = await reindexAll(env, "u-1", { force: false });

  assert.equal(result.indexed, 0);
  assert.equal(result.ftsUpdated, 1);
});

test("H1：content_fts 已正确时不重复写入", async () => {
  const title = "端口约定";
  const content = "项目统一使用 5432 端口";
  const row = makeRecord({
    id: "m-3",
    type: "instruction",
    subtype: "rule",
    title,
    content,
    content_fts: segmentForIndex(`${title} ${content}`),
  });
  const { env } = createReindexEnv([row]);

  const result = await reindexAll(env, "u-1", { force: true });

  assert.equal(result.ftsUpdated, 0);
});
