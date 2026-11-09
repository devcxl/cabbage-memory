<div align="center">

# @devcxl/cabbage-memory

[![npm version](https://img.shields.io/npm/v/@devcxl/cabbage-memory)](https://www.npmjs.com/package/@devcxl/cabbage-memory)
[![npm downloads](https://img.shields.io/npm/dm/@devcxl/cabbage-memory)](https://www.npmjs.com/package/@devcxl/cabbage-memory)
[![license](https://img.shields.io/npm/l/@devcxl/cabbage-memory)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/devcxl/opencode-memory/ci.yml?branch=main)](https://github.com/devcxl/opencode-memory/actions)

[English](./README.md) | [中文](./README.zh.md)

基于 Cloudflare Workers（D1 + Vectorize）的远程记忆系统，供 OpenCode 插件与 MCP 客户端使用。

</div>

## 架构（v2）

- **存储**：Cloudflare D1 统一记忆表（`daily` / `fact` / `instruction` / `digest` 四种类型）+ Vectorize 向量索引 + Workers AI（Qwen3 embedding / LLM）
- **搜索**：混合检索 —— FTS 全命中记录硬性优先（两桶分层），桶内 RRF 融合向量排名；支持分面实体硬过滤
- **每日总结**：每天北京时间 04:00（UTC 20:00）自动把昨天的 daily 日志总结成一条事实记忆（digest），幂等可补跑
- **记忆新陈代谢**：fact 写入后由 LLM 异步判定重复/推翻/矛盾，被推翻的旧事实自动退役
- **认证**：Web 管理台 GitHub OAuth2 登录；插件与 MCP 使用个人中心生成的 API Token（仅存哈希）
- **接入**：OpenCode 原生插件（含上下文注入）/ MCP Streamable HTTP（`/mcp`，7 个工具）/ REST API

## 仓库结构

```
opencode-memory/
├── apps/
│   ├── api/            # Cloudflare Worker：REST + MCP + OAuth + cron
│   ├── plugin/         # @devcxl/cabbage-memory  OpenCode 插件（纯远程模式）
│   ├── pi-extension/   # @devcxl/cabbage-memory-pi  pi coding agent 扩展
│   └── web/            # Web 管理台（React，随 Worker 部署）
├── packages/shared/    # 共享类型与领域模型
├── scripts/            # 迁移与运维脚本
└── docs/               # 架构文档与 ADR
```

## 部署与迁移（v1 → v2）

Wrangler 命令需在 `apps/api` 下执行（`wrangler.toml` 所在目录）。

1. 应用数据库迁移并部署：

   ```bash
   cd apps/api
   wrangler d1 migrations apply memory-db --remote
   cd ../..
   pnpm --filter @devcxl/cabbage-memory-web build
   pnpm deploy:api
   ```

2. 配置 secrets 并注册 GitHub OAuth App（回调地址 `<worker-url>/auth/github/callback`）：

   ```bash
   cd apps/api
   wrangler secret put JWT_SECRET
   wrangler secret put GITHUB_CLIENT_ID
   wrangler secret put GITHUB_CLIENT_SECRET
   # 迁移旧数据时必需（/api/admin/remap-user 鉴权）
   wrangler secret put ADMIN_SECRET
   ```

   可选：在 `apps/api/wrangler.toml` 的 `OAUTH_ALLOWLIST` 填入允许登录的 GitHub id/login；留空则首个登录者认领实例。

3. 首次 GitHub 登录后，在 Web 个人中心生成 API Token，然后迁移旧数据归属并重建向量索引（`--admin-secret` 必须与 Worker 的 `ADMIN_SECRET` 一致）：

   ```bash
   npx tsx scripts/migrate-v2.ts \
     --url https://<worker-url> \
     --token opm_xxx \
     --old-user-id <旧JWT sub> \
     --admin-secret <ADMIN_SECRET> \
     --force-reindex
   ```

## 插件配置

在 `~/.config/opencode/opencode.json` 中添加：

```json
{
  "plugin": [
    ["@devcxl/cabbage-memory", {
      "remote": {
        "apiUrl": "https://<worker-url>",
        "apiKey": "env://OPM_API_KEY"
      }
    }]
  ]
}
```

环境变量 `OPM_API_URL` / `OPM_API_KEY` 优先于配置文件。

## MCP 接入

Streamable HTTP 端点：`<worker-url>/mcp`，认证使用 API Token：

```bash
claude mcp add --transport http memory https://<worker-url>/mcp --header "Authorization: Bearer opm_xxx"
```

工具：`memory_add` / `memory_search` / `memory_get` / `memory_update` / `memory_delete` / `memory_context` / `memory_digest_status`。

## pi 接入

[pi coding agent](https://pi.dev/) 不支持 MCP（官方设计决策），使用原生 TypeScript 扩展接入（见 [apps/pi-extension](./apps/pi-extension/README.md)）：

```bash
git clone https://github.com/devcxl/opencode-memory.git
pi -e ./opencode-memory/apps/pi-extension/src/extension.ts

export OPM_API_URL="https://<worker-url>"
export OPM_API_KEY="opm_xxx"
```

提供 `memory_add/search/get/update/delete/list` 六个工具，并在每次会话开始注入服务端组装的记忆上下文。

## 工具: memory（OpenCode 插件）

| 操作 | 描述 | 关键参数 |
|------|------|----------|
| `add` | 创建记录 | `type`: daily/fact/instruction, `subtype`, `title`, `content`, `scope`, `date`, `tags` |
| `search` | 混合搜索 | `query`, `max_results`, `scope` |
| `get` | 读取单条 | `id` |
| `update` | 更新单条 | `id`, `title`, `content`, `tags` |
| `delete` | 删除单条 | `id` |
| `list` | 列出最近记录 | `type`, `date`, `scope` |

`scope`: `project`（当前 git 项目）/ `global`（全局）/ `all`。

**记忆类型：**

| type | 用途 |
|------|------|
| `daily` | 每日流水日志（默认写入目标，04:00 被 digest 汇总） |
| `fact` | 原子事实（偏好/情景/知识），一个主题一条，写入后自动查重与新陈代谢 |
| `instruction` | 稳定指令（身份/规则/工作流） |
| `digest` | 每日总结（系统自动生成，每天每项目一条） |

## 上下文注入

会话开始时自动注入：身份 + 用户偏好 + 规则/工作流 + 项目知识 + 最近 3 条 digest，由服务端 `/api/context` 组装，无需发版即可调整注入策略。

## 许可证

MIT
