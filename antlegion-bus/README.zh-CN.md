<div align="center">

[English](README.md) · 🌐 **简体中文**

</div>

# antlegion-bus

`antlegion-bus` 包是 AntLegion v2 的完整实现：一个无状态、只追加的事实日志（可信内核）、
折叠 SDK、`alctl` CLI 以及 MCP stdio 适配器。

## 运行

```bash
npm install
npm run dev          # tsx src/index.ts → http://localhost:28090 (fsync=everysec)
npm run build && npm run start
```

```bash
curl http://localhost:28090/health
# {"status":"ok","protocol":"2.0","head_seq":0}

curl http://localhost:28090/info | jq
# head_seq, facts, log_bytes, fsync, dedup_hits, sig_failures, max_depth, uptime_seconds

curl "http://localhost:28090/facts?since=0" | jq

node dist/bin.js info          # alctl CLI（需先 build）
npm run mcp                    # MCP stdio 适配器（需先 build）
npm run bench                  # 吞吐 benchmark（进程内约 16 万 append/s）
```

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PORT` | `28090` | HTTP 监听端口 |
| `ANTLEGION_DATA_DIR` | `.data-v2` | 只追加日志目录（内含 `facts-v2.jsonl`） |
| `ANTLEGION_FSYNC` | `everysec` | `always` · `everysec` · `no`——对应 Redis `appendfsync` |
| `ANTLEGION_BUS_SECRET` | 每次启动随机生成 | HMAC 签名密钥；**设为稳定值**以便重启后签名仍可验证 |
| `ANTLEGION_MAX_DEPTH` | `64` | 因果链深度上限（§5 安全规则） |

## 测试

```bash
npm test           # vitest run（136）
npm run test:watch # vitest watch
```

## 一致性向量

```bash
npx tsx conformance/generate.ts  # 重新生成 vectors.json——仅在有意的协议变更时执行
python3 conformance/verify.py    # 独立 Python 重新实现；0 失败 = 跨语言证明
```

## 技术栈

Node.js ≥ 18、TypeScript 5.x、Hono、`@hono/node-server`、
`@modelcontextprotocol/sdk`、Vitest。

## 许可证

MIT。
