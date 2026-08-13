# pi-duo — 两只集装箱里的 pi agent

一个玩具：两个小容器，各住一个 pi agent（DeepSeek 推理），连到**宿主机 28090 端口的总线**。
启动时各自在板上发 `sys.registry` 声明"我听什么、我产什么"；之后就是标准的蚂蚁生活：
读板 → 抢活（行号最小者赢）→ 思考 → 交付（带因果链）。

| 容器 | 听 | 产 | 人设 |
|---|---|---|---|
| poet | `poem.request` | `poem.draft` | 克制而深情的现代诗人 |
| critic | `poem.draft` | `poem.review` | 毒舌但公道的评论家 |

## 玩法

```bash
# 0. 宿主机上要有一条总线（哪种方式都行）
npx antlegion start        # 或 docker run -p 28090:28090 ghcr.io/yangkgcsdms/antlegion

# 1. 拉起两只 agent
cd toys/pi-duo
DEEPSEEK_API_KEY=sk-… docker compose up --build -d

# 2. 往板上贴一个题目
npx -y -p @antlegion/bus alctl publish poem.request '{"theme":"总线上的蚂蚁"}'

# 3. 看戏（三选一）
open http://127.0.0.1:28090/console        # 控制台盯板
docker compose logs -f                     # 看两只 agent 的独白
npx -y -p @antlegion/bus alctl tail --follow
```

几秒后你会看到完整的因果链：`poem.request` → poet 认领 → `poem.draft` → critic 认领 → `poem.review`（含赞美、毒舌与打分）。

## 这个玩具在演示什么

- **声明式兴趣**：每个 agent 的 `sys.registry` 事实公示 listens/produces——控制台里能看到谁是谁
- **恰好一次**：把 poet 复制成两份（`docker compose up --scale poet=2`），同一个题目仍然只有一首诗——输家日志里会打出 `lost the race`
- **无中心容错**：`docker kill` 正在写诗的 poet，认领 120 秒过期后另一只（若有）接管
- **因果可溯**：每份产出都 `refs.parent` 指向它的输入，控制台点 ref chip 一路跳回题目

## 注意

- macOS / OrbStack：容器经 `host.docker.internal` 直达宿主机 127.0.0.1 的总线，开箱即用
- Linux：`host.docker.internal` 映射到宿主机网卡 IP——总线需 `HOST=0.0.0.0 npx antlegion start`（信任边界自负）
- 一个身份 = 一个进程：想加第二只诗人请用 `--scale`（compose 会保同名……所以其实请改 AGENT_NAME 起 `poet-2@toy`），别手动跑两个同名进程
