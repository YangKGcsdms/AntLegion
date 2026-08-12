# 闭合事实模型的环 —— 兴趣、孤儿与上下文

🌐 [English](FACT-MODEL.md) · **简体中文**

总线给你一条不可变、有序的事实流，加上少数几个折叠（生命周期、信任、因果）。这足以完成
**协调**，但一个运行中的舰群总会追问三个裸日志答不上来的问题：

1. **每个 Agent 到底关心什么、又产出什么？** —— Agent 的*兴趣*与*发布*之间的环，此前是隐式的。
2. **有人在听吗？** —— 一条事实可能被发进虚空，没有任何 Agent 消费它（*孤儿*），却无人告警。
3. **这条事实真的可据以行动吗？** —— 一条事实可能只说"X 坏了"，不足以让关心它的 Agent 判断。

三者都以**纯附加**方式解决——都是从同一元语折叠出来的约定：没有新线上操作，不改 §3.1–§3.4
折叠，不改 §4 一致性向量。规范摘要见 `PROTOCOL.zh-CN.md` §3.5–§3.6。

---

## 1. Agent 声明 interests + publishes（`sys.registry`）

启动时，Agent 以一条事实自报：

```json
{
  "type": "sys.registry",
  "author": "planner",
  "payload": {
    "interests": ["req.*", "task.*"],   // 它消费/认领的事实类型 glob
    "publishes": ["plan.ready"]          // 它发出的类型
  }
}
```

`interests`/`publishes` 是**通用**能力声明。dev-chain 的 stage DCU 早就有这个形状
（`listens`/`produces`），它们仍作为回退被读取，所以没有回归——但现在每个 Agent 说同一套
词汇，「我监听什么」与「我产出什么」之间的环变成显式、可折叠的。

```bash
alctl publish sys.registry '{"interests":["task.*"],"publishes":["task.done"]}' --author planner
alctl colony        # → 当前名册，每个 Agent 取最新一条注册
```

`colony(stream)` 对每个 author 保留**最新**注册（重新注册即就地更新——与 supersession 同样
的 latest-wins 思路）。

## 2. 孤儿事实 + 声明缺口

`orphanReport(stream)` 把名册对着真实事实流折叠，给出三类协调缺口：

| 缺口 | 含义 |
|---|---|
| **孤儿类型** | 流里某事实类型，**没有**任何 Agent 的 `interests` glob 匹配它——有产出却无人消费 |
| **未匹配的兴趣** | Agent 声明关心某类型，但它**从未出现**——它在等一个没人产出的事实 |
| **沉默的发布** | Agent 声明会 `publishes` 某类型，却**从未真正发出** |

机制/约定类型被排除——没人"关心"一条 claim：`_.*`（claim/resolve/release/vote/tombstone）、
`sys.*`（注册）、以及 `context.*`（见下节——`contextGaps` 已经跟踪请求是否被回应，这比"无人
声明关心"是严格更好的信号）。

```bash
alctl orphans       # → { orphanTypes, unmatchedInterests, silentPublishes, registeredAgents }
```

控制台的**舰群**页实时渲染它，并在存在孤儿时升起横幅——监管者无需读日志就看到"4 个事实类型
无人声明关心"。若**零**注册，报告如实说明（`registeredAgents: 0`），而不是假装一切正常。

## 3. 上下文充分性闭环（当一条事实太薄）

模型此前没答的硬情形：Agent 认领/读到一条事实，却发现它**不足以判断**——"build.failed：坏了"
什么可行动信息都没有。默默丢弃就丢了信号。闭环如下：

```
build.failed  (author: ci, payload: {note: "坏了"})
   ▲ refs.about
context.requested  (author: dev, payload: {question: "哪个目标？什么错误？"})
   ▲ refs.parent / refs.answers
context.provided   (author: ci, payload: {answer: "arm64，链接器 undefined symbol"})
```

- 关心它的 Agent 不猜、也不放弃——它发布一条 `context.requested`，点名那条太薄的事实
  （`refs.about`）与自己的问题。
- 能回答的人（通常是原作者）以 `context.provided` 回链（`refs.parent` 或 `refs.answers`）回应。
- `contextGaps(stream)` 列出**仍未获回应**的请求——控制台在**待补充上下文**下呈现它们，一旦
  回答落盘即清空。

```bash
alctl ask-context <太薄事实-id> "哪个目标、什么错误？"        --author dev
alctl provide-context <请求-id> '{"answer":"arm64，链接器报错"}' --author ci
alctl context-gaps   # → 未回应的请求
```

### 为什么用一条事实，而不是更重的 schema？

我们**刻意不**给每条事实强加一个必填的"context"schema。两个原因：(1) 那会是触碰 §4 向量的
线上变更；(2) 多数事实本就够用——为服务罕见情形而给所有事实强加上下文块，是拿常见情形交税。
请求/回应*约定*让核心保持最小，同时把"这不够，我需要更多"变成同一条事实流里一等的、可审计的
动作。事实**仍可**主动携带上下文（`refs.parent` 指向来源、payload 里放 `context` 字段）；这个
闭环是当它没带时的兜底。

---

## 代码在哪

- `antlegion-bus/src/fold.ts` §7/§8 —— `colony`、`orphanReport`、`contextGaps`
  （纯函数、附加式；单测在 `test/fold-colony.test.ts`）。
- `antlegion-bus/src/cli.ts` —— `colony`、`orphans`、`ask-context`、
  `provide-context`、`context-gaps` 动词。
- `antlegion-bus/console/console.html` —— **舰群**页（双语），同一逻辑内联移植（与生命周期
  徽章一样的做法）。
- `ant/src/dcus/*` —— dev-chain 舰队现在声明 `interests`/`publishes`。
