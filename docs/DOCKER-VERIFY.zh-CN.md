[English](DOCKER-VERIFY.md) · 🌐 **简体中文**

# Docker：构建、运行，并验证 CLI 事件流

容器就是总线；Agent 从外部用 `alctl` CLI 驱动它（见 [AGENT-CLI.zh-CN.md](AGENT-CLI.zh-CN.md)）。这是一套端到端检查，确认容器化的总线能支撑完整的 Agent 循环。

## 1. 构建与运行

```bash
docker build -t antlegion .                      # 在仓库根执行
docker run -d --name antlegion-bus -p 28090:28090 \
  -e ANTLEGION_BUS_SECRET=your-stable-secret \
  -v antlegion-data:/data antlegion
curl -sf localhost:28090/health                  # {"status":"ok","protocol":"2.0",…}
open http://localhost:28090/console               # 运维控制台（事实流 / 舰群 / 健康）
```

`HOST=0.0.0.0` 是故意烤进镜像的——容器本来就是从外部访问的，docker 网络就是信任边界（总线信任它的调用方；不要暴露到不受信任的网络上）。

**务必传入稳定的 `ANTLEGION_BUS_SECRET`。** 不传的话，总线每次启动都会新造一把 HMAC 密钥，重启前写入的签名就验不过了（表现为 `/info` 里 `sig_failures > 0`）。

## 2. 通过 CLI 验证整条事件流

```bash
ANTLEGION_BUS_URL=http://localhost:28090 node deploy/verify-cli-eventflow.mjs
```

预期：**13 passed, 0 failed**——涵盖 Agent 注册（`sys.registry`）、发布、恰好一次认领（一个赢家，输家以 1 退出）、解决、因果子事实、双观察者信任共识、孤儿检测、上下文请求/应答闭环，以及服务端查询校验（非法 `limit` 返回 400）。

不设 `ANTLEGION_BUS_URL` 直接跑，它会自启一条本地总线——不用 Docker 也能快速自查。

## 3. 重启持久性（AOF + 签名完整性）

```bash
docker restart antlegion-bus && sleep 5
curl -s localhost:28090/info    # head_seq/facts 与之前一致，sig_failures: 0
```

事实挺过重启，且每一个签名都能重新验证——因为数据目录是一个卷，而密钥是稳定的。

## 排障：`docker pull` 卡住（中国大陆 / 受限网络）

如果 `docker build` 或 `docker pull node:20-alpine` 在打印 `Using default tag: latest` 之后毫无进展地卡住——而 daemon 本身健康、容器出网也正常（`getent hosts registry-1.docker.io` 能解析、TCP 443 能连）——那就是 daemon 连不上 Docker Hub 的 CDN。从镜像站拉基础镜像并重打标签，然后照常构建：

```bash
docker pull docker.m.daocloud.io/library/node:20-alpine
docker tag docker.m.daocloud.io/library/node:20-alpine node:20-alpine
docker build -t antlegion .      # 现在基础镜像在本地就能解析到
```

其他同样可用的镜像站：`docker.1panel.live`、`dockerpull.com`、`hub.rat.dev`、`docker.nju.edu.cn`（都接受 `/library/<image>:<tag>` 形式）。或者在 daemon 配置里一次性配好 `registry-mirrors`。
