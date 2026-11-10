import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryClient } from "../src/client.js";
import { handleAdd, handleSearch, handleList } from "../src/handlers.js";

const ORIGINAL_FETCH = globalThis.fetch;

/** 按路径路由的 fetch mock */
function mockFetch(
  routes: Array<{
    match: (url: string, init?: RequestInit) => boolean;
    respond: (url: string, init?: RequestInit) => unknown;
  }>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });
    const route = routes.find((r) => r.match(url, init));
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    const data = route.respond(url, init);
    return new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

const client = new MemoryClient({
  apiUrl: "https://mem.test",
  apiKey: "opm_k",
});

describe("MemoryClient", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("create 走 POST /api/memories 并携带 Bearer", async () => {
    const calls = mockFetch([
      {
        match: (url, init) =>
          url.endsWith("/api/memories") && init?.method === "POST",
        respond: () => ({ id: "m-1" }),
      },
    ]);
    const result = await client.create({
      type: "daily",
      content: "今天完成表结构设计",
    });
    expect(result.id).toBe("m-1");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer opm_k");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.type).toBe("daily");
  });

  test("业务失败抛出可读错误", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: false, error: "boom" }), {
        status: 200,
      })) as typeof fetch;
    await expect(client.list()).rejects.toThrow(/boom/);
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("list 把查询参数拼到 URL", async () => {
    const calls = mockFetch([
      { match: (url) => url.includes("/api/memories?"), respond: () => [] },
    ]);
    await client.list({ type: "daily", date: "2026-09-01", limit: 10 });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("type")).toBe("daily");
    expect(url.searchParams.get("date")).toBe("2026-09-01");
    expect(url.searchParams.get("limit")).toBe("10");
    globalThis.fetch = ORIGINAL_FETCH;
  });
});

describe("handlers", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("handleAdd：fact 必须带合法 subtype，daily 默认挂当前项目", async () => {
    const calls = mockFetch([
      {
        match: (url, init) =>
          url.endsWith("/api/memories") && init?.method === "POST",
        respond: () => ({ id: "m-2" }),
      },
    ]);

    const ok = await handleAdd(
      client,
      {
        action: "add",
        type: "fact",
        subtype: "knowledge",
        title: "T",
        content: "C",
      },
      "owner/repo",
    );
    expect(ok).toContain("m-2");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.project_id).toBe("owner/repo");

    // 非法 subtype 拒绝（不发起请求）
    expect(
      handleAdd(
        client,
        {
          action: "add",
          type: "fact",
          subtype: "rule",
          title: "T",
          content: "C",
        },
        null,
      ),
    ).rejects.toThrow(/subtype/);
    // daily 默认挂当前项目（此处 projectId=null → 不带 project_id）
    expect(
      await handleAdd(
        client,
        { action: "add", type: "daily", content: "x" },
        null,
      ),
    ).toContain("m-2");
  });

  test("handleSearch：scope=project 限定当前项目，scope=global 不过滤", async () => {
    const calls = mockFetch([
      {
        match: (url) => url.endsWith("/api/memories/search"),
        respond: () => [
          {
            id: "r1",
            type: "fact",
            subtype: "knowledge",
            title: "T",
            content: "华北销售额 100 万",
            tags: "[]",
            project_id: "",
            date: "",
            created_at: 1,
            bucket: "full-match",
            score: 0.1,
            snippet: "",
          },
        ],
      },
    ]);

    const projectScoped = await handleSearch(
      client,
      { action: "search", query: "销售额", scope: "project" },
      "owner/repo",
    );
    expect(JSON.parse(calls[0].init?.body as string).project_id).toBe(
      "owner/repo",
    );
    expect(projectScoped).toContain("r1");

    const globalScoped = await handleSearch(
      client,
      { action: "search", query: "销售额", scope: "global" },
      "owner/repo",
    );
    expect(
      JSON.parse(calls[1].init?.body as string).project_id,
    ).toBeUndefined();
    expect(globalScoped).toContain("华北销售额 100 万");
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("handleList 按 type 分组输出", async () => {
    mockFetch([
      {
        match: (url) => url.includes("/api/memories?"),
        respond: () => [
          {
            id: "d1",
            type: "daily",
            subtype: "",
            title: "",
            content: "day log",
            project_id: "",
            date: "2026-09-01",
            created_at: 1,
          },
          {
            id: "f1",
            type: "fact",
            subtype: "knowledge",
            title: "Fact",
            content: "a fact",
            project_id: "",
            date: "",
            created_at: 2,
          },
        ],
      },
    ]);
    const out = await handleList(client, { action: "list" }, null);
    expect(out).toContain("## daily (2026-09-01) (1)");
    expect(out).toContain("## fact (1)");
    expect(out).toContain("day log");
  });
});

describe("scope 语义", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("handleAdd：scope=global 覆盖自动项目", async () => {
    const calls = mockFetch([
      {
        match: (url, init) =>
          url.endsWith("/api/memories") && init?.method === "POST",
        respond: () => ({ id: "m-1" }),
      },
    ]);

    await handleAdd(
      client,
      {
        action: "add",
        type: "fact",
        subtype: "knowledge",
        title: "T",
        content: "C",
        scope: "global",
      },
      "owner/repo",
    );

    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.project_id).toBeUndefined();
  });

  test("handleSearch：project/global/all 发送对应 scope", async () => {
    const calls = mockFetch([
      {
        match: (url) => url.endsWith("/api/memories/search"),
        respond: () => [],
      },
    ]);

    await handleSearch(
      client,
      { action: "search", query: "q", scope: "project" },
      "owner/repo",
    );
    await handleSearch(
      client,
      { action: "search", query: "q", scope: "global" },
      "owner/repo",
    );
    await handleSearch(
      client,
      { action: "search", query: "q", scope: "all" },
      "owner/repo",
    );

    const bodies = calls.map((c) => JSON.parse(c.init?.body as string));
    expect(bodies[0].scope).toBe("project");
    expect(bodies[0].project_id).toBe("owner/repo");
    expect(bodies[1].scope).toBe("global");
    expect(bodies[1].project_id).toBeUndefined();
    expect(bodies[2].scope).toBe("all");
    expect(bodies[2].project_id).toBeUndefined();
  });

  test("handleList：scope=global 发送 scope=global 且不带 project_id", async () => {
    const calls = mockFetch([
      { match: (url) => url.includes("/api/memories?"), respond: () => [] },
    ]);

    await handleList(
      client,
      { action: "list", scope: "global" },
      "owner/repo",
    );

    const url = new URL(calls[0].url);
    expect(url.searchParams.get("scope")).toBe("global");
    expect(url.searchParams.get("project_id")).toBeNull();
  });
});
