🌐 [English](QUICKSTART.md) · **简体中文**

# 快速上手 —— AntLegion v2(只追加事实总线)

从克隆到两个 Agent 借不可变事实协作,五分钟搞定。v2 是一次
[第一性原理重构](../PROTOCOL.md):总线只负责给事实排序、校验、盖时间戳并按区间返回;
所有协作都是客户端 SDK 里的**读者折叠(reader fold)**。

## 1. 运行总线

```bash
cd antlegion-bus
npm install
npm run dev          # tsx src/index.ts — http://localhost:28090
#   或:npm run build && npm run start
```

验证:

```bash
curl http://localhost:28090/health
# → {"status":"ok","protocol":"2.0","head_seq":0}
```

## 2. 全部线面(一写一读)

```bash
# 追加一条事实(总线会分配 seq、recv、id、sig)
curl -sX POST http://localhost:28090/facts \
  -H 'content-type: application/json' \
  -d '{"type":"demo.hello","author":"me","ts":1748300000,"payload":{"msg":"hi"}}'
# → 201 {"seq":1,"recv":...,"id":"…","sig":"…","deduped":false}

# 从游标读取(git-fetch 风格)
curl -s "http://localhost:28090/facts?since=0"
```

这就是总线的全部 API。`claim`、`resolve`、`vote`、`trust`、`state` **都不是**端点——
它们是「关于事实的事实」,由客户端折叠得到。

## 3. 在代码里协作(折叠 SDK)

```ts
import { ClientV2, httpTransport } from "antlegion-bus/client";

const alice = new ClientV2(httpTransport("http://localhost:28090"), "alice");
const bob   = new ClientV2(httpTransport("http://localhost:28090"), "bob");

const { id } = await alice.publish("task.build", { target: "todo-app" });

// 两者竞争;恰好一个赢(seq 最小者——全序的定理)
const [ra, rb] = await Promise.all([alice.claim(id), bob.claim(id)]);
const winner = ra.won ? alice : bob;

await winner.resolve(id, [{ type: "build.done", payload: { ok: true } }]);

await alice.state(id);  // → { state: "resolved", owner: <winner> }
await bob.state(id);    // 相同——任何客户端都能从日志折叠出同一状态
```

客户端表面与 v1 的 MCP 工具一样小
(`publish / claim / resolve / release / observe / state / trustOf / causation`);
SDK 吸收了「追加→读回确认→折叠」的活(见 PROTOCOL.md §3)。

## 4. 一条事实长什么样

```jsonc
{ "type": "build.failed", "author": "ci", "ts": 1748300000,
  "payload": { "...": "..." },
  "refs": { "parent": "<id>", "claim_of": "<id>", "vote": "<id>", "supersedes": "<id>" } }
```

`refs` 是唯一的关系机制。保留事实类型 `_.claim`、`_.resolve`、`_.release`、`_.vote`、
`_.tombstone` 承载协作动词。

## 下一步去哪

- [PROTOCOL.md](../PROTOCOL.md) —— v2 协议,从唯一本原推导而来。
- `antlegion-bus/src/` —— 内核(`bus.ts`)、线面(`server.ts`)、折叠(`fold.ts`)、SDK(`client.ts`)。
- `antlegion-bus/test/` —— core / lifecycle / trust+causation / server / client / e2e。

## 状态

Alpha。可达但尚未构建:v2 的 MCP 适配器(N3)、跨语言一致性向量(N6)、面向公网的
鉴权/限流加固(N7)。
