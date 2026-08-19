[English](CONFIGURATION.md) · 🌐 **简体中文**

# 配置与运维

总线完全由环境变量配置——即 `redis.conf` 的对应物，在 [`antlegion-bus/src/config.ts`](../antlegion-bus/src/config.ts) 中解析。没有配置文件要维护，除了日志之外也没有任何状态。

## 环境变量

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `28090` | HTTP 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址——总线信任它的调用方（与 Redis 相同的安全模型）；只在你控制的信任边界内设为 `0.0.0.0` |
| `ANTLEGION_DATA_DIR` | `.data-v2` | 日志文件（`facts-v2.jsonl`）所在目录 |
| `ANTLEGION_FSYNC` | `everysec` | `always`（最高持久性）· `everysec`（最多丢 1 秒）· `no`（交给操作系统）——对应 Redis 的 `appendfsync` |
| `ANTLEGION_BUS_SECRET` | *（每次启动随机）* | HMAC 签名密钥。**生产环境务必设一个稳定值**——否则重启前写入的签名将无法再被验证 |
| `ANTLEGION_MAX_DEPTH` | `64` | 因果链最大深度（§5 安全上限；内容寻址让环从结构上不可能出现） |

```bash
# 生产风格的启动方式
ANTLEGION_BUS_SECRET=a-stable-32-char-secret \
ANTLEGION_DATA_DIR=/var/lib/antlegion \
ANTLEGION_FSYNC=always \
node dist/index.js
```

客户端与 CLI 通过 `ANTLEGION_BUS_URL`（默认 `http://localhost:28090`）找到总线，通过 `ANTLEGION_AUTHOR` 获得稳定的 Agent 身份——见 [AGENT-CLI.zh-CN.md](AGENT-CLI.zh-CN.md)。

## 几种跑法

**前台**（开发）：

```bash
npx @antlegion/bus
```

**守护进程**（redis-server 风格——pidfile 与日志就放在日志文件旁边）：

```bash
npm i -g @antlegion/bus
antlegion start     # 分离运行
antlegion status    # pid · /health · 各文件位置
antlegion stop      # SIGTERM——退出时刷盘
```

**Docker** —— 一个进程、一个卷；`/data` 里只有日志，别无他物：

```bash
docker run -d --name antlegion -p 28090:28090 \
  -v antlegion-data:/data -e ANTLEGION_BUS_SECRET=change-me \
  ghcr.io/yangkgcsdms/antlegion
```

镜像在容器内绑定 `0.0.0.0`（docker 网络就是信任边界）；只在你信任调用方的地方发布端口。想自己构建，在仓库根执行 `docker build -t antlegion .`——容器端到端验证流程见 [DOCKER-VERIFY.md](DOCKER-VERIFY.md)。

**从源码**（开发）：

```bash
git clone https://github.com/YangKGcsdms/AntLegion.git
cd AntLegion/antlegion-bus
npm install && npm run dev
```

## 运维速查

- **数据在哪？** 一个只追加文件：`$ANTLEGION_DATA_DIR/facts-v2.jsonl`（默认 `.data-v2/`）。备份就是复制它。
- **从头开始：** 停掉总线，删掉数据目录。别处没有任何状态。
- **Ctrl-C 是安全的：** 关闭时刷盘；恢复时重放日志并验证每一个签名。
- **务必设稳定的 `ANTLEGION_BUS_SECRET`：** 不设的话总线每次启动都会新造一把 HMAC 密钥——重启后早先写入的 `sig` 就再也无法验证（会以 `sig_failures` 出现在 `/info` 里）。

## 安全模型

与 Redis 相同的信任边界：总线**信任它的调用方**。默认绑定 `127.0.0.1`；只在你自己控制的边界内（docker 网络、VPC）才设 `HOST=0.0.0.0`。目前还没有鉴权——不要把它暴露到不受信任的网络上。

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| `error: port 28090 already in use` | 已经有一条总线在跑——直接复用，或 `PORT=28091 npx @antlegion/bus` |
| `/info` 里 `sig_failures > 0` | 总线以不同的（或缺失的）`ANTLEGION_BUS_SECRET` 重启了——设一个稳定值 |
| alctl/SDK 报 `error: cannot reach bus at <url>` | 那个 URL 上没有总线——`npx @antlegion/bus`，或把 `ANTLEGION_BUS_URL` 指对 |
| `resolve ignored — fact is owned by 'X'` | 你没抢到认领；这正是系统在正常工作。查一下状态，去干别的活 |
| 两个单元处理了同一个任务 | 是不是两个进程共用了一个身份/author？一个身份 = 一个进程（[为什么](../research/s2-experiments-2026-08.md)） |
