# @devcxl/cabbage-memory-pi

[pi coding agent](https://pi.dev/) 的原生记忆扩展，接入 [cabbage-memory](https://github.com/devcxl/cabbage-memory) 远程记忆服务（Cloudflare Workers + D1 + Vectorize）。

> pi 不支持 MCP（官方设计决策，见 [作者说明](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)），因此以原生 TypeScript 扩展接入。

## 功能

- **memory 工具**：`memory_add` / `memory_search`（混合搜索，精确匹配优先）/ `memory_get` / `memory_update` / `memory_delete` / `memory_list`
- **上下文注入**：每次会话开始，自动把服务端组装的记忆上下文（身份 + 偏好 + 规则 + 项目知识 + 最近 digest）注入 system prompt
- **项目作用域**：自动探测当前 git 项目（owner/repo），写入默认挂到当前项目；搜索/列出默认 project（当前项目 + 全局知识），`scope: "global"` 仅全局，`scope: "all"` 全部项目

## 安装

前置条件：已部署 cabbage-memory Worker，并在 Web 管理台个人中心生成 API Token。

方式一（推荐）：从仓库源码直接加载

```bash
git clone https://github.com/devcxl/cabbage-memory.git
pi -e ./cabbage-memory/apps/pi-extension/src/extension.ts
```

方式二：复制到全局扩展目录（在扩展目录里解析依赖）

```bash
mkdir -p ~/.pi/agent/extensions/cabbage-memory
cp -r apps/pi-extension/src ~/.pi/agent/extensions/cabbage-memory/
cp apps/pi-extension/package.json ~/.pi/agent/extensions/cabbage-memory/
cd ~/.pi/agent/extensions/cabbage-memory && npm install
```

## 配置

环境变量（与 OpenCode 插件共用同一份 opencode.json 配置作为回退）：

```bash
export OPM_API_URL="https://<worker-url>"
export OPM_API_KEY="opm_xxx"    # Web 个人中心生成
```

也支持在 `~/.config/opencode/opencode.json` 的插件配置里填写 `remote.apiUrl` / `remote.apiKey`（支持 `env://` 前缀）。

## 工具用法示例

```
memory_add    type=daily   content="完成了认证模块重构"
memory_add    type=fact subtype=knowledge title="端口约定" content="项目统一使用 5432 端口" scope=global
memory_search query="华北销售额"
memory_list   date=2026-09-01
```

每天北京时间 04:00，服务端会自动把昨天的 daily 日志总结成一条事实记忆（digest）。
