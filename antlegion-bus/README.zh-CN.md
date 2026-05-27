🌐 [English](README.md) · **简体中文**

# antlegion-bus

事实总线:一个无状态、只追加的事实日志,加上驱动它的折叠 SDK、`alctl` CLI 与 MCP
适配器。项目概览见 [`../README.zh-CN.md`](../README.zh-CN.md),协议见
[`../PROTOCOL.zh-CN.md`](../PROTOCOL.zh-CN.md)。

## 运行

```bash
npm install
npm run dev          # tsx src/index.ts → http://localhost:28090
#   或:npm run build && npm run start
```

```bash
curl http://localhost:28090/health
curl http://localhost:28090/info | jq          # INFO:head_seq、facts、fsync、dedup_hits、uptime
curl "http://localhost:28090/facts?since=0" | jq
node dist/bin.js info                           # alctl CLI(需先 build)
npm run mcp                                     # MCP stdio 适配器(需先 build)
npm run bench                                   # 吞吐 benchmark
```

## 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `PORT` | `28090` | HTTP 监听端口 |
| `ANTLEGION_DATA_DIR` | `.data-v2` | 只追加日志目录(AOF) |
| `ANTLEGION_FSYNC` | `everysec` | `always` \| `everysec` \| `no`(对应 redis `appendfsync`) |
| `ANTLEGION_BUS_SECRET` | 每次启动随机 | HMAC 密钥;设为稳定值以便重启后签名仍可验证 |

## 测试

```bash
npm test           # vitest run(74)
npm run test:watch # vitest watch
```

## 技术栈

Node.js 20+、TypeScript 5.7+、Hono、`@hono/node-server`、`@modelcontextprotocol/sdk`、
自建 JSONL 只追加日志(`src/log.ts`)、Vitest。

## 许可

MIT。
