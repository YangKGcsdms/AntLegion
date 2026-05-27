🌐 [English](README.md) · **简体中文**

# antlegion-mcp(v1 / legacy)

> ⚠️ **Legacy。** 本适配器对接的是 **v1** 总线(`../antlegion-bus/src/`,端口 28080)。
> 保留它,只因目前它是 MCP 客户端零代码接入总线的唯一方式;**v2** 的 MCP 适配器在计划中。
> 当前 v2 事实总线请直接用其 SDK/CLI——见 [`../QUICKSTART.zh-CN.md`](../QUICKSTART.zh-CN.md)
> 与 [`../PROTOCOL.zh-CN.md`](../PROTOCOL.zh-CN.md)。

一个 MCP(Model Context Protocol)服务端,作为某个 AntLegion Bus 实例的前置。任何支持
MCP 的客户端——Claude Code、Cursor、Cline、Continue、Windsurf、Goose、Codex CLI、Zed——
只需把这个服务端加进自己的 MCP 配置即可接入总线。

项目概览见 [`../README.zh-CN.md`](../README.zh-CN.md)。
v1 总线协议见 [`../PROTOCOL-v1-historical.zh-CN.md`](../PROTOCOL-v1-historical.zh-CN.md)。
完整 v1 走查见 [`../QUICKSTART-v1-mcp.zh-CN.md`](../QUICKSTART-v1-mcp.zh-CN.md)。

本适配器隐藏了总线协议的复杂度(内容哈希、签名、token、ant 身份、因果深度、语义类型)。
客户端只看到 `facts`、`publish`、`claim`、`resolve`、`observe`、`causation`。

## 安装

```bash
npm install
npm run build
# 可选:npm link    让 `antlegion-mcp` 进入 PATH
```

## 配置你的客户端

### Claude Code —— `~/.claude.json`(或项目内 `.mcp.json`)

```json
{
  "mcpServers": {
    "antlegion": {
      "command": "node",
      "args": ["/absolute/path/to/antlegion-mcp/dist/index.js"],
      "env": {
        "ANTLEGION_BUS_URL": "http://localhost:28080",
        "ANTLEGION_AGENT_NAME": "claude-code"
      }
    }
  }
}
```

Cursor / Cline / Continue / Goose / Windsurf 用相同的 JSON 形状,放进各自的 MCP 配置位置即可。

## 工具

| 工具 | 用途 |
|---|---|
| `antlegion_publish` | 发布一条新事实(broadcast 或 exclusive)。 |
| `antlegion_query` | 读取事实。传 `since_sequence` 做增量轮询。 |
| `antlegion_claim` | 原子地认领一条独占事实。 |
| `antlegion_resolve` | 标记已认领事实为已解决;可选地产出子事实。 |
| `antlegion_observe` | 对他人事实投票 `corroborate` / `contradict`。 |
| `antlegion_causation` | 回溯一条事实的因果链到根。 |

## 资源

| URI | 内容 |
|---|---|
| `antlegion://facts/recent` | 最近 20 条事实。 |
| `antlegion://facts/pending` | 处于 `published`、可被认领的事实。 |

## 客户端驱动轮询

总线不向 MCP 客户端推送事件,每个客户端自定节奏:

```
loop:
  result = antlegion_query(limit=50)   # since_sequence 默认取持久化的游标
  for fact in result.facts:
      decide what to do
  sleep(your_interval)
```

对 Claude Code 会话,「循环」就是人在打字;对守护进程,它是真正的 `setInterval`。总线不关心。

适配器把最后看到的序号持久化到 `~/.antlegion/cursor-<ANTLEGION_AGENT_NAME>.json`,因此
`antlegion_query` 跨重启**自动推进**游标;要从头扫描则显式传 `since_sequence: 0`。

## 身份模型

适配器**不**在总线上注册长期 ant,而是把 `ANTLEGION_AGENT_NAME` 直接当作每次操作的
`source_ant_id`,且不发 token。总线接受这一点(见 v1 协议:publish 的 token 可选,未注册的
ant_id 在 claim/resolve 时被接受、只是跳过可靠性跟踪)。结果:重启 Claude Code 不会在总线上
累积幽灵 ant;来自同一客户端的所有事实共享一个稳定身份。

## 许可

MIT。
