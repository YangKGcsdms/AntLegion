<!-- lang-nav --> 🌐 [English](QUICKSTART-v1-mcp.md) · **简体中文**

# 快速上手 —— Claude Code + AntLegion Bus(v1 / MCP · legacy)

> ⚠️ **Legacy。** 本文走查的是 **v1** 总线(`antlegion-bus/src/`,端口 28080)与
> **MCP 适配器**(`antlegion-mcp/`)。保留它,因为 MCP 适配器目前是 MCP 客户端
> (Claude Code、Cursor……)零代码接入总线的唯一方式。当前 **v2** 事实总线(CLI + SDK + AOF)
> 见 [`QUICKSTART.zh-CN.md`](QUICKSTART.zh-CN.md) 与 [`PROTOCOL.zh-CN.md`](PROTOCOL.zh-CN.md)。

从克隆仓库到在 Claude Code 里发出第一条事实,五分钟。

## 前置

- Docker + Docker Compose
- Node.js 20+
- 已安装并登录 Claude Code

## 1. 启动总线

```bash
cp .env.example .env
docker compose up -d
```

验证:

```bash
curl http://localhost:28080/health
# → {"status":"ok","timestamp":...}
```

## 2. 构建 MCP 服务端

```bash
cd antlegion-mcp
npm install
npm run build
```

## 3. 注册到 Claude Code

编辑 `~/.claude.json`,加入(或合并进)`mcpServers`:

```json
{
  "mcpServers": {
    "antlegion": {
      "command": "node",
      "args": ["/绝对路径/到/antlegion-platform/antlegion-mcp/dist/index.js"],
      "env": {
        "ANTLEGION_BUS_URL": "http://localhost:28080",
        "ANTLEGION_AGENT_NAME": "claude-code"
      }
    }
  }
}
```

重启正在打开的 Claude Code 会话。

## 4. 用起来

在 Claude Code 里:

```
你:在 antlegion bus 上发一条 fact,type 是 demo.hello,payload 写 {"msg":"first contact"}

Claude:[tool] antlegion_publish({ fact_type: "demo.hello", payload: { msg: "first contact" } })
        [result] { fact_id: "8f3a...", state: "published", sequence_number: 1 }
        完成。
```

直接核对:

```bash
curl http://localhost:28080/facts | jq '.[0]'
```

你会看到这条 fact,带有总线计算出的 `content_hash` 与 `signature`。

## 5. 因果链

针对刚才那条发一个 follow-up(`fact_type: "demo.reply"`,设上 `parent_fact_id`),再
`antlegion_causation` 一下,即可看到 `chain_length: 2`(根 demo.hello → demo.reply)。
因果链是自动的,每条事实都知道自己的祖先。

## 6. 独占认领/解决

发一条 `mode: "exclusive"` 的 fact;在另一个终端(或另一个 MCP 客户端)用 REST 抢先 claim,
再回到 Claude Code 尝试 claim——会得到「already claimed by ...」。总线在无编排器、无选主的
情况下,用一次 HTTP 调用强制了独占性。

## 下一步

- [README.zh-CN.md](README.zh-CN.md) —— 概览、架构、6 个 MCP 工具
- [PROTOCOL-v1-historical.zh-CN.md](PROTOCOL-v1-historical.zh-CN.md) —— v1 协议(归档)
- [antlegion-mcp/README.zh-CN.md](antlegion-mcp/README.zh-CN.md) —— 每个工具参数、各客户端配置
- 当前 v2:[QUICKSTART.zh-CN.md](QUICKSTART.zh-CN.md)
