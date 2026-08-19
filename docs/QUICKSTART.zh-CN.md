<div align="center">

[English](QUICKSTART.md) · 🌐 **简体中文**

</div>

# 快速上手 —— AntLegion v2

从 `npx` 到两个 Agent——同一台机器或两台——借不可变事实共享同一个世界，五分钟搞定。

总线只负责给事实排序、校验、盖时间戳并按区间返回。读者想知道的一切——X 现在是什么
（`current`）、它怎么来的（`causation`）、引发了什么（`descendants`）、信任、所有权
（`claim`/`resolve`）——都是客户端 SDK 里的**读者折叠**。完整规范见 [PROTOCOL.md](../PROTOCOL.md)。

## 1. 运行总线

```bash
npx @antlegion/bus
# [antlegion-v2] append-only fact bus on http://localhost:28090 (fsync=everysec)
```

或从源码运行：

```bash
cd antlegion-bus
npm install
npm run dev            # 或先 build 再运行：npm run build && npm run start
```

验证服务是否就绪：

```bash
curl http://localhost:28090/health
# {"status":"ok","protocol":"2.0","head_seq":0}
```

**或使用 Docker**（从仓库根目录构建）：

```bash
docker build -t antlegion ..
docker run -p 28090:28090 -e ANTLEGION_BUS_SECRET=your-stable-secret antlegion
```

## 2. 全部线面（一写一读）

```bash
# 追加一条事实——总线分配 seq、recv、id、sig
curl -sX POST http://localhost:28090/facts \
  -H 'content-type: application/json' \
  -d '{"type":"demo.hello","author":"me","ts":1748300000,"payload":{"msg":"hi"}}'
# 201 {"seq":1,"recv":1748300000.4,"id":"b3f1…","sig":"…","deduped":false}

# 从游标读取（类似 git fetch）
curl -s "http://localhost:28090/facts?since=0"

# 常用过滤器
curl -s "http://localhost:28090/facts?since=0&type=task.*"
curl -s "http://localhost:28090/facts?since=0&refs.claim_of=<id>"

# 获取当前头部（启动一个「只取最新」的读者）
curl -s http://localhost:28090/facts/head
# {"head_seq":1}

# 总线信息（INFO 对应物）
curl -s http://localhost:28090/info | jq
# {"protocol":"2.0","head_seq":1,"facts":1,"fsync":"everysec","sig_failures":0,…}
```

这就是总线的全部 API。`claim`、`resolve`、`vote`、`trust`、`state` **都不是**端点——
它们是「关于事实的事实」，由客户端折叠得到。

## 3. 用终端操作（`alctl`）

`alctl` 是 `redis-cli` 的对应物——`npm i -g @antlegion/bus` 即可安装
（或者给每条命令加前缀 `npx -y -p @antlegion/bus`）。每条命令在 stdout 输出机器可读的
JSON；人类可读的错误走 stderr 并以非零码退出：

```bash
# 发布
alctl publish task.build '{"target":"todo-app"}' --author alice
# {"id":"b3f1…","seq":1,"deduped":false}

# 认领（恰好一个赢；输家退出码为 1）
alctl claim b3f1… --author bob
# {"won":false,"winner":"alice"}

# 查看生命周期状态
alctl state b3f1…
# {"state":"claimed","owner":"alice"}

# 解决——只有认领胜者可以；其他人会以非零码退出：
#   error: resolve ignored — fact <id> is owned by 'alice' (you are 'bob')
alctl resolve b3f1… --author alice
# {"state":"resolved","owner":"alice"}

# tail 打印一次当前流即退出；--follow 持续轮询实时输出
alctl tail
alctl tail --follow

# 完整总线信息（protocol、head_seq、facts、fsync、sig_failures、secret_stable……）
alctl info
```

`--author <名字>` 是全局旗标，对所有会写入事实的命令生效。身份解析顺序：
`--author` > `ANTLEGION_AUTHOR` > `<系统用户名>@<主机名>`（稳定的按用户默认值，
因此前一条命令里的 `claim` 可以在后一条命令里 `resolve`）。`ANTLEGION_BUS_URL`
指定总线地址（默认 `http://localhost:28090`）；如果没有总线在监听，你会看到
`error: cannot reach bus at <url> — start one with: npm run dev`。

## 4. 从代码接入（折叠 SDK）

```typescript
import { ClientV2, httpTransport } from "@antlegion/bus/client";

const alice = new ClientV2(httpTransport("http://localhost:28090"), "alice");
const bob   = new ClientV2(httpTransport("http://localhost:28090"), "bob");

// 发布一条待处理的工作项
const { id } = await alice.publish("task.build", { target: "todo-app" });

// 两者竞争认领；序号最小者胜出——确定性，无锁
const [ra, rb] = await Promise.all([alice.claim(id), bob.claim(id)]);
const winner = ra.won ? alice : bob;

// 胜者完成处理，可选地发出子事实（构成因果链）
await winner.resolve(id, [{ type: "build.done", payload: { ok: true } }]);

// 任意客户端从同一不可变日志折叠出相同状态
await alice.state(id);  // { state: "resolved", owner: <winner> }
await bob.state(id);    // 完全相同——确定性折叠
```

客户端接口：`publish` / `claim` / `resolve` / `release` / `observe` /
`state` / `trustOf` / `causation` / `query` / `snapshot`。

SDK 吸收了「追加→读回确认→折叠」的底层工作（PROTOCOL.md §3）。

## 5. 事实的结构

```jsonc
{
  "seq":    1,              // 总线分配（可信）
  "recv":   1748300000.4,   // 总线盖章的可信时间——折叠基于此，而非 ts
  "id":     "b3f1…",        // sha256(canonical(record))
  "type":   "build.failed", // 点分类型；保留类型以 "_." 开头
  "author": "ci",
  "ts":     1748300000,     // 作者声明（仅供参考）
  "payload": { "…": "…" },
  "refs": {                 // 永远是事实 id，绝不是 Agent id
    "parent":    "<id>",    // 因果前驱
    "claim_of":  "<id>",    // 对目标的独占认领
    "resolves":  "<id>",    // 目标已处理完毕
    "vote":      "<id>",    // 佐证 / 反驳
    "supersedes":"<id>",    // 本事实取代目标
    "tombstones":"<id>"     // 目标已删除/GC
  }
}
```

## 6. 接入一个 agent（`alctl` CLI）

无头 / PI agent（Claude Code、Cursor、Codex CLI、shell 工具、cron 任务）通过 shell
调用 `alctl` 驱动总线——动词与 §3 相同，每个对应一次折叠调用。给它一个总线地址和
稳定身份：

```bash
export ANTLEGION_BUS_URL=http://localhost:28090   # 默认
export ANTLEGION_AUTHOR=my-agent                   # 或每条命令加 --author

# agent 循环：按游标读取、恰好一次认领、解决
alctl read --type 'task.*' --since "$CURSOR"
alctl claim <id> && alctl resolve <id>
alctl publish task.done '{"result":"ok"}' --parent <id>
```

`alctl claim` 只有唯一胜者退出码为 0，agent 据此分支，绝不重复执行。完整的 agent
指南（动词 ↔ 折叠映射、`sys.registry` 事实、崩溃恢复）见
[AGENT-CLI.zh-CN.md](AGENT-CLI.zh-CN.md)。

## 7. 验证多 Agent swarm

```bash
# 21 个 Agent，50 项任务扇出/汇聚，恰好一次（dupes=0 missing=0）
npx tsx examples/swarm-v2.ts

# 崩溃 + 认领超时重派
npx tsx examples/scenario-resilience.ts

# 同行评审：决策者只对 consensus 行动
npx tsx examples/scenario-consensus.ts

# 因果流水线 build→test→deploy + 取代
npx tsx examples/scenario-pipeline.ts
```

每个示例都会在临时端口上自启自己的总线——无需提前启动任何总线。

## 8. 持久化与恢复

总线在 `ANTLEGION_DATA_DIR`（默认 `.data-v2`）里写入单个 `facts-v2.jsonl` 文件。
用相同的 `ANTLEGION_BUS_SECRET` 重启，完全恢复：

```bash
# 启动、写入几条事实、停止
ANTLEGION_BUS_SECRET=stable node dist/index.js &
curl -sX POST http://localhost:28090/facts \
  -H 'content-type: application/json' \
  -d '{"type":"t","author":"u","ts":1,"payload":{}}'
kill %1

# 重启——head_seq 恢复，sig_failures=0
ANTLEGION_BUS_SECRET=stable node dist/index.js &
curl -s http://localhost:28090/info | jq '.head_seq, .sig_failures'
# 1
# 0
```

压缩（BGREWRITEAOF 对应物）：

```bash
curl -sX POST http://localhost:28090/admin/rewrite | jq
# {"stripped": 0}   # 已 tombstone/取代的事实 payload 被丢弃
```

## 下一步去哪

- [PROTOCOL.md](../PROTOCOL.md) —— 完整 v2 规范（§3 折叠规则为规范性）。
- [EVOLUTION.md](EVOLUTION.md) —— 项目为何如此。
- `antlegion-bus/src/` —— 内核（`bus.ts`）、线面（`server.ts`）、折叠（`fold.ts`）、SDK（`client.ts`）。
- `antlegion-bus/conformance/` —— 跨语言互操作向量 + Python 校验器。
- `antlegion-bus/test/` —— 147 个测试（vitest）。
