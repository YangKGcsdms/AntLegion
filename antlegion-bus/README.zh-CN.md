<!-- lang-nav --> 🌐 [English](README.md) · **简体中文**

# antlegion-bus

事实总线服务端。本包包含**两代**(项目概览见
[`../README.zh-CN.md`](../README.zh-CN.md)):

- **v2(当前)** —— `src/v2/`:无状态、只追加的事实日志;含义由 SDK/CLI 里的读者折叠得出。
  协议:[`../PROTOCOL.zh-CN.md`](../PROTOCOL.zh-CN.md)。
- **v1(legacy)** —— `src/`:原始可变状态引擎。协议:
  [`../PROTOCOL-v1-historical.zh-CN.md`](../PROTOCOL-v1-historical.zh-CN.md)。

## 运行 —— v2(当前)

```bash
npm install
npm run dev:v2          # tsx src/v2/index.ts → http://localhost:28090
#   或:npm run build && npm run start:v2
```

```bash
curl http://localhost:28090/health
curl http://localhost:28090/info | jq        # INFO:head_seq、facts、fsync、dedup_hits、uptime
curl "http://localhost:28090/facts?since=0" | jq
node dist/v2/bin.js info                      # alctl CLI(需先 build)
npm run bench:v2                              # 吞吐 benchmark
```

| 变量 | 默认 | 用途 |
|---|---|---|
| `PORT` | `28090` | HTTP 监听端口 |
| `ANTLEGION_DATA_DIR` | `.data-v2` | 只追加日志目录(AOF) |
| `ANTLEGION_FSYNC` | `everysec` | `always` \| `everysec` \| `no`(对应 redis `appendfsync`) |
| `ANTLEGION_BUS_SECRET` | 每次启动随机 | HMAC 密钥;设为稳定值以便重启后签名仍可验证 |

## 运行 —— v1(legacy)

```bash
npm run build
npm start                # node dist/index.js → http://localhost:28080
```

```bash
curl http://localhost:28080/health
curl http://localhost:28080/facts | jq
curl http://localhost:28080/stats | jq
curl http://localhost:28080/facts/cursor   # 当前 head 序号
```

## 测试

```bash
npm test           # vitest run(全部,共 244)
npm run test:v2    # 只跑 v2
npm run test:watch # vitest watch
```

## 技术栈

Node.js 20+、TypeScript 5.7+、Hono、`@hono/node-server`、自建 JSONL 只追加日志、Vitest。

## 许可

MIT。
