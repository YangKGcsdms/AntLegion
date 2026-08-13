# 把 Hermes 框成 DCU：接入 AntLegion 事实总线的技术方案

> 状态：待评审（2026-08-13）
> 作者：Hermes Agent（Carter.Yang 的助手）
> 范围：Hermes（Nous Research 的 AI agent）作为外部 harness，以 DCU 协议接入 AntLegion 总线

---

## 1. 背景与动机

AntLegion 是 Carter.Yang 设计的**事实总线**：append-only、内容寻址、读者折叠语义。
DCU（Domain Control Unit）是总线上的常驻工作单元，遵循
`poll → 折叠 → claim（恰好一次）→ act → resolve（带证据）` 循环。

现有 DCU 的 act 步骤有三种实现：
- `simulated`：确定性模拟 worker（验证机制）
- `llm`：直接调 DeepSeek API（workers-llm.ts）
- **缺一个：把真实 agent（如 Hermes / Claude Code / Codex）作为 harness 接入**

本方案解决：**Hermes 本身能否作为 DCU 接入总线**——即让一个小脚本声明
"Hermes 关心哪些事实、会发布哪些事实"，总线有新事实时唤醒 Hermes 处理，
处理结果以带证据的产物事实回写总线。

## 2. 结论：可以，用 Hermes 的 Webhook 平台

Hermes 原生提供 **Webhook 订阅机制**（`hermes webhook` CLI）：
外部服务 POST 事件到 Hermes 的 webhook URL → 校验 HMAC 签名 → 触发一次
agent 运行（带全工具集）→ 结果投递到指定目标。

这与 DCU 的"被事实唤醒 → 处理 → 发布结果"模型一一对应。

### 2.1 概念映射

| DCU 概念 | Hermes 对应物 | 实现方式 |
|---------|--------------|---------|
| 声明关心的事实（listens） | webhook 订阅的 `--events` / payload 过滤器 | `hermes webhook subscribe` |
| 声明会发布的事实（produces） | 订阅的 `--prompt` 模板 + agent 工具调用 | prompt 指示 agent 处理完用 curl append 回总线 |
| init 注册（sys.registry） | 订阅描述 / 路由脚本 | `--description` / `--script` |
| act（干活） | Hermes 完整 agent 能力（工具/技能/记忆） | Hermes 本身就是 harness |
| 证据形状（adjudicator） | agent 输出 + 总线侧裁决 | 回写的 payload 走现有 adjudicator 检查 |
| 崩溃恢复 | 总线 claim 过期机制（§3.1） | Hermes 未响应 → 认领过期 → 兄弟 DCU 重做 |

### 2.2 整体架构

```
┌──────────────────────┐
│  AntLegion 总线 :28090 │
└──────┬───────▲───────┘
       │ ①     │ ③
       ▼       │
┌──────────────┴───────┐
│  桥脚本（bridge）      │  轮询新事实 → POST 到 Hermes webhook
│  poll → POST :8644    │  收到结果 → append 回总线
└──────────┬───────────┘
           │ ②
           ▼
┌──────────────────────┐
│  Hermes Webhook :8644 │  HMAC 校验 → 唤醒 agent
└──────────┬───────────┘
           │
           ▼
│   Hermes agent 处理    │  全工具集：分析/写码/查库
│   （作为 harness）     │
```

**三个组件：**

1. **Hermes Webhook 平台**（需启用）
   ```yaml
   # config.yaml
   platforms:
     webhook:
       enabled: true
       extra:
         port: 8644
         secret: "<强密钥>"
   ```

2. **桥脚本**（`bridge/` 下，轮询总线 → 触发 Hermes）
   轮询 `GET /facts?since=<cursor>`，有新事实且类型匹配订阅 → POST 到 Hermes
   webhook URL（带 HMAC 签名）→ 等待 agent 处理 → 把 agent 回写的结果
   append 回总线。

3. **订阅声明**（`hermes webhook subscribe`）
   ```bash
   hermes webhook subscribe antlegion-reqs \
     --events "req.registered,plan.ready" \
     --prompt "总线新事实：{payload}。请处理，完成后用 curl 把结果事实 append 回总线（type=harness.done, refs.parent=<原事实id>）" \
     --deliver local
   ```

## 3. 守卫与可靠性（guard pattern）

### 3.1 总线侧守卫（免费继承）

| 守卫 | 机制 | 防什么 |
|------|------|--------|
| 认领过期 §3.1 | Hermes 未响应 → 认领到期 → 兄弟重做 | Hermes 挂掉不丢任务 |
| resolve 校验 | 只有赢家能 resolve | 重复/越权提交 |
| 恰好一次 | 最低 seq 赢家胜出 | 双 harness 重复执行 |
| 证据裁决 | adjudicator 检查产物形状 | harness 输出不合格卡住链条 |

### 3.2 Hermes/桥侧守卫（需实现）

| 守卫 | 说明 |
|------|------|
| 超时 | 桥脚本对 Hermes 响应设超时（如 5 分钟），超时视为失败并记录 |
| 失败证据 | Hermes 失败也回写（ok:false + 原因），让看板可见而非消失 |
| 防自触发循环 | Hermes 回写的事实类型 ≠ 订阅类型；或订阅过滤掉 `author=hermes` 的事实 |
| HMAC 签名 | 桥脚本 POST 时携带订阅 secret 签名，防伪造事件 |
| 输出上限 | agent 回写 payload 设大小上限 |

## 4. 已知权衡

| 维度 | 轻量 DCU（simulated/llm） | Hermes harness |
|------|--------------------------|----------------|
| 延迟 | ~1-2s 轮询 | 桥轮询 + webhook 即时，略慢 |
| 成本 | 低（小模型/确定性） | 高（全工具集 agent） |
| 能力 | 单一任务 | 复杂任务（写码/分析/多步推理）|
| 适用 | 高频小动作 | 低频复杂任务 |

**定位**：Hermes 适合当"重活 harness"（需要推理/工具/记忆的任务），
高频小动作仍用轻量 DCU。两者可共存于同一总线——认领机制天然仲裁。

## 5. 实施步骤

1. **启用 Hermes Webhook 平台**：改 config.yaml + 重启 hermes-gateway
2. **写桥脚本**：`bridge/bus-to-hermes.ts`（轮询 + POST + 回写）
3. **声明订阅**：`hermes webhook subscribe`（关心 req.registered / plan.ready）
4. **端到端测试**：总线发事实 → Hermes 被唤醒 → 处理 → 回写 → 看板可见
5. **接入 devchain**：作为 dev 阶段 worker 的替代（或并存）

## 6. 相关代码位置

- 总线 SDK：`antlegion-bus/src/client.ts`（ClientV2: publish/claim/resolve）
- DCU 循环：`ant/src/runtime.ts`（runDCU: poll → fold → act → resolve）
- DCU 舰队：`ant/src/dcus/devchain-dcus.ts`（stage DCU / adjudicator / watchdog）
- LLM worker 参考：`ant/src/dcus/workers-llm.ts`
- Hermes webhook 文档：`~/.hermes/skills/autonomous-ai-agents/hermes-agent/references/webhooks.md`

---

*本文档描述"把 Hermes 框成 DCU"的技术方案；实现代码位于 `bridge/` 目录（或按评审结论调整）。*
