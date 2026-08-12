<div align="center">

[English](README.md) · 🌐 **简体中文**

</div>

# @antlegion/bus

自治智能体的只追加**事实总线**——*事实，而非命令*。
Agent 发布、读取、认领、解决不可变的内容寻址事实，从不互相寻址。
协调（恰好一次的认领、信任、取代、因果）从单一全序中涌现，
以纯**读者折叠**在客户端计算——总线本身保持无状态。

本包是完整实现：可信内核（HTTP 服务器）、折叠 SDK、`alctl` CLI。

## 快速上手

**1. 起一条总线**（五秒钟，零配置）：

```bash
npx @antlegion/bus        # → http://localhost:28090
```

**2. 把你的 agent 指向总线**（Claude Code、Cursor、Codex CLI……）。agent 通过
`alctl` CLI 驱动总线——每个动词对应一次折叠调用：

```bash
export ANTLEGION_BUS_URL=http://localhost:28090    # 另加 ANTLEGION_AUTHOR=my-agent
npx -p @antlegion/bus alctl read --type 'task.*'   # 再 claim / resolve
```

两个驱动 `alctl` 的 agent 仅通过事实流即可协作：一个发布 `task.todo` 事实，
另一个认领并解决——恰好一次，没有编排器。完整 agent 指南见
[`../docs/AGENT-CLI.md`](../docs/AGENT-CLI.zh-CN.md)。

**3. 用 `alctl` 从终端操作**：

```bash
npx -p @antlegion/bus alctl publish task.todo '{"title":"hello"}'
npx -p @antlegion/bus alctl tail --follow
npx -p @antlegion/bus alctl info
```

**4. 盯着它跑**——总线自带两个只读页面：`/dashboard`（演示看板）和 **`/console`**（运维控制台：带过滤的事实流 `tail -f` + INFO 健康视图）。

```bash
# 启动时会打印：
# dashboard → http://127.0.0.1:28090/dashboard · console → http://127.0.0.1:28090/console
```

## 从源码运行

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
npm run bench                  # 吞吐 benchmark（进程内约 16 万 append/s）
```

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PORT` | `28090` | HTTP 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址。总线信任它的调用方（与 Redis 同款安全模型）——只有在信任边界内（如 docker 网络）才设 `0.0.0.0` |
| `ANTLEGION_DATA_DIR` | `.data-v2` | 只追加日志目录（内含 `facts-v2.jsonl`） |
| `ANTLEGION_FSYNC` | `everysec` | `always` · `everysec` · `no`——对应 Redis `appendfsync` |
| `ANTLEGION_BUS_SECRET` | 每次启动随机生成 | HMAC 签名密钥；**设为稳定值**以便重启后签名仍可验证 |
| `ANTLEGION_MAX_DEPTH` | `64` | 因果链深度上限（§5 安全规则） |

客户端（`alctl` CLI、SDK）：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `ANTLEGION_BUS_URL` | `http://localhost:28090` | CLI / SDK 连接的总线地址 |
| `ANTLEGION_AUTHOR` | `<系统用户名>@<主机名>` | CLI 身份；`--author <名字>` 可按命令覆盖 |

`alctl` 在 stdout 输出机器可读的 JSON（如 `{"id":…,"seq":…,"deduped":…}`、
`{"won":…,"winner":…}`、`{"state":…,"owner":…}`），人类可读的错误走 stderr 并以
非零码退出——包括当你不是认领胜者时的 `resolve`。`tail` 打印一次当前流即退出；
`tail --follow` 持续轮询实时输出。子路径导入（`antlegion-bus/client`、
`antlegion-bus/bus`、`antlegion-bus/fold` 等）已在 `package.json` 的 `exports` 中映射。

## 测试

```bash
npm test           # vitest run（147）
npm run test:watch # vitest watch
```

## 一致性向量

```bash
npx tsx conformance/generate.ts  # 重新生成 vectors.json——仅在有意的协议变更时执行
python3 conformance/verify.py    # 独立 Python 重新实现；0 失败 = 跨语言证明
```

## 技术栈

Node.js ≥ 18、TypeScript 5.x、Hono、`@hono/node-server`、Vitest。

## 许可证

MIT。
