import test from "node:test";
import assert from "node:assert/strict";
import { postProcessFact } from "../src/services/memory-service";
import type { Env } from "../src/types";

interface Candidate {
  id: string;
  title: string;
  content: string;
}

interface RecordedStatement {
  sql: string;
  args: unknown[];
}

function createFactEnv(candidates: Candidate[], llm: unknown) {
  const batches: RecordedStatement[][] = [];

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            sql,
            args,
            async all<T>() {
              if (sql.includes("SELECT id, title, content FROM memories")) {
                const ids = args.slice(0, args.length - 1) as string[];
                return {
                  results: candidates.filter((c) => ids.includes(c.id)) as T[],
                };
              }
              return { results: [] as T[] };
            },
            async first<T>() {
              return null as T;
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(statements: RecordedStatement[]) {
      batches.push(statements.map((s) => ({ sql: s.sql, args: s.args })));
      return [];
    },
  };

  const env = {
    DB: db as unknown as Env["DB"],
    VEC: {
      async query() {
        return { matches: candidates.map((c) => ({ id: c.id, score: 0.9 })) };
      },
      async deleteByIds() {},
      async upsert() {},
    } as unknown as Env["VEC"],
    AI: {
      async run(
        _model: string,
        input: { messages?: unknown[]; text?: unknown },
      ) {
        if (Array.isArray(input.messages))
          return { response: JSON.stringify(llm) };
        return { data: [[0.1]] };
      },
    } as unknown as Env["AI"],
    JWT_SECRET: "test",
  } as Env;

  return { env, batches };
}

const candidates: Candidate[] = [
  { id: "old-1", title: "Old 1", content: "old fact 1" },
  { id: "old-2", title: "Old 2", content: "old fact 2" },
];

test("H6：只接受候选集内的 supersedes/contradicts，忽略外部 id 和自指", async () => {
  const { env, batches } = createFactEnv(candidates, {
    duplicate_of: null,
    supersedes: ["outside", "old-1", "self-id"],
    contradicts: ["old-2", "outside-2"],
    entities: [{ key: "Region", value: " 华北 " }],
  });

  await postProcessFact(env, "u-1", "self-id", "new fact");

  assert.equal(batches.length, 1);
  const statements = batches[0];

  assert.ok(
    statements.some(
      (s) =>
        s.sql.includes("INSERT OR IGNORE INTO memory_links") &&
        s.args[1] === "old-1" &&
        s.args[2] === "supersedes",
    ),
  );
  assert.ok(
    statements.some(
      (s) => s.sql.includes("SET archived = 1") && s.args[0] === "old-1",
    ),
  );
  assert.ok(
    statements.some(
      (s) =>
        s.sql.includes("INSERT OR IGNORE INTO memory_links") &&
        s.args[1] === "old-2" &&
        s.args[2] === "contradicts",
    ),
  );
  assert.ok(!statements.some((s) => s.args.includes("outside")));
  assert.ok(!statements.some((s) => s.args.includes("outside-2")));
  assert.ok(
    !statements.some(
      (s) => s.sql.includes("SET archived = 1") && s.args[0] === "self-id",
    ),
  );
  assert.ok(
    statements.some(
      (s) =>
        s.sql.includes("INSERT OR IGNORE INTO memory_entities") &&
        s.args[2] === "region" &&
        s.args[3] === "华北",
    ),
  );
});

test("H6：duplicate_of 只允许候选集内旧事实，写 derived_from 并归档新事实", async () => {
  const { env, batches } = createFactEnv(candidates, {
    duplicate_of: "old-1",
    supersedes: ["old-2"],
    contradicts: [],
    entities: [{ key: "region", value: "华北" }],
  });

  await postProcessFact(env, "u-1", "self-id", "duplicate fact");

  assert.equal(batches.length, 1);
  const statements = batches[0];
  assert.ok(
    statements.some(
      (s) =>
        s.sql.includes("INSERT OR IGNORE INTO memory_links") &&
        s.args[1] === "old-1" &&
        s.args[2] === "derived_from",
    ),
  );
  assert.ok(
    statements.some(
      (s) => s.sql.includes("SET archived = 1") && s.args[0] === "self-id",
    ),
  );
  assert.ok(
    !statements.some(
      (s) => s.args[1] === "old-2" && s.args[2] === "supersedes",
    ),
  );
  assert.ok(
    !statements.some((s) =>
      s.sql.includes("INSERT OR IGNORE INTO memory_entities"),
    ),
  );
});

test("H6：duplicate_of 自指或候选集外时不产生任何写操作", async () => {
  const { env, batches } = createFactEnv(candidates, {
    duplicate_of: "self-id",
    supersedes: ["outside"],
    contradicts: [],
    entities: [],
  });

  await postProcessFact(env, "u-1", "self-id", "new fact");

  assert.equal(batches.length, 0);
});
