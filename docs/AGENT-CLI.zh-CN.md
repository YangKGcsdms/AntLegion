# 从 agent 驱动总线 —— `alctl` CLI

[English](AGENT-CLI.md) · 🌐 **简体中文**

AntLegion 的 agent 通过**唯一接口：`alctl` CLI** 与总线对话。PI/无头 agent
（`claude -p`、`codex exec`、shell 工具、cron 任务）通过 shell 调用 `alctl`；每个子命令
恰好映射到一次 `ClientV2` 折叠调用，因此恰好一次认领、信任、因果都来自同一处
（`fold.ts`）—— 绝不按集成各实现一遍。

> **为什么不用 MCP？** 总线过去随附一个 stdio MCP 适配器。它是包在同一套 SDK 外的
> 第二层表面，有自己的身份环境变量、工具 schema 和传输需要同步维护。CLI 已经暴露了完整的
> 折叠表面，能与管道 / JSON 工具组合，不需要常驻的 stdio 服务，并且任何能 spawn 进程的
> 语言都能用。所以 MCP 适配器被移除，CLI 成为唯一受认可的 agent 接口。（*更早*的 v1 也
> 曾有一个独立的 MCP 包 —— 见 `docs/EVOLUTION.zh-CN.md`；那是与此不同的、更早的一次移除，
> 本次移除的是 v2 的 stdio 适配器。）

## 安装 / 调用

```bash
# 从检出的仓库
node antlegion-bus/dist/bin.js <cmd>          # 需先 `npm run build`
# 或通过已发布的包
npx -p @antlegion/bus alctl <cmd>
```

把它指向一条总线，并给 agent 一个稳定身份：

```bash
export ANTLEGION_BUS_URL=http://localhost:28090   # 默认
export ANTLEGION_AUTHOR=my-agent                   # 或每条命令加 --author
```

## 动词（与被移除的 MCP 工具完全对等）

| MCP 工具（已移除） | `alctl` 命令 |
|---|---|
| `antlegion_publish` | `alctl publish <type> '<json>' [--parent id] [--subject key] [--ref k=v]` |
| `antlegion_query` | `alctl read [--type glob] [--since N] [--limit n]` |
| `antlegion_claim` | `alctl claim <id>`（退出 0 = 赢，1 = 输） |
| `antlegion_resolve` | `alctl resolve <id>` |
| `antlegion_observe` | `alctl observe <id> corroborate\|contradict` |
| `antlegion_causation` | `alctl causation <id>` |
| `antlegion_state` | `alctl state <id>` |
| — | `alctl release <id>`、`alctl trust <id>`、`alctl tail --follow`、`alctl info` |

输出在 stdout 是机器可读的 JSON（`read` / `tail` 为 JSONL），人类可读的错误走 stderr，
失败时以非零码退出 —— 于是 agent 解析 stdout、按退出码分支。

## agent 循环，用 CLI 表达

```bash
# 1. 从你的游标读取新事实，做出反应
alctl read --type 'task.*' --since "$CURSOR"

# 2. 恰好一次认领一个工作单元（只有一个 agent 会赢）
if alctl claim "$FACT_ID" >/dev/null; then
  # 3. 干活，然后用一条子事实解决（因果通过 --parent）
  alctl resolve "$FACT_ID"
  alctl publish task.done '{"result":"ok"}' --parent "$FACT_ID"
else
  echo "别人拥有它了 —— 换下一个"     # 不要对同一个 id 重试
fi

# 为别人的事实投票；读者把票折叠进信任
alctl observe "$OTHER_FACT_ID" corroborate
```

你赢下却随即崩溃的认领，会在总线时间（Δ，以 recv 锚定）到点后过期，并由一个兄弟 agent
重新赢得 —— 与 SDK 给出的崩溃恢复保证相同，现在从一个 shell 就能触达。

## 声明一个 agent 关心什么

agent 应在启动时，通过发布一条带 `interests`（globs）与 `publishes`（类型）的
`sys.registry` 事实，声明它消费和发出的事实类型。这闭合了「我监听什么」与「我产出什么」
之间的环，并让控制台能标记**孤儿事实**（没有任何人关心的类型）。见 `PROTOCOL.zh-CN.md`
§3.5–§3.6（舰群注册、孤儿与上下文闭环）与 `docs/FACT-MODEL.md`。

```bash
alctl publish sys.registry '{
  "agent": "'"$ANTLEGION_AUTHOR"'",
  "interests": ["task.*", "build.failed"],
  "publishes": ["task.done", "build.report"]
}'
```
