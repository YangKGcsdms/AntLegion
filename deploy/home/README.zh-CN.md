# 家庭事实总线：开发启动

## 不使用 Docker 直接启动

需要 Node.js 20 或更高版本和 npm。在仓库根目录运行：

```sh
./deploy/home/local.sh
```

脚本首次运行时安装总线依赖，每次启动时构建代码，并在前台运行；按 Ctrl-C 停止。直接打开 `http://127.0.0.1:28090/console`，无需登录。本地数据保存在 `deploy/home/.data/`，与 Docker 数据卷分开；备份时同时保存该目录和包含签名密钥的 `deploy/home/.env`。两种方式默认使用同一端口，不能同时启动。

## Docker 部署

需要 Linux / NAS、Docker 和 Docker Compose。进入仓库根目录：

```sh
./deploy/home/antlegion.sh up
```

浏览器直接打开 `http://127.0.0.1:28090/console`。本地和 Docker 开发启动均免登录，旧 `.env` 中保留的访问令牌不会启用鉴权。`deploy/home/.env` 中的签名密钥用于日志签名校验，不是访问令牌；需保留并备份，重新生成会导致历史签名无法验证。脚本默认只监听本机。

需要从家庭局域网访问时，在 `.env` 中设置 `ANTLEGION_BIND=0.0.0.0`，然后重新运行 `up`，访问 `http://NAS的局域网地址:28090/console`。默认 `everysec` 刷盘，突发故障可能丢失最近尚未同步的写入；可将 `ANTLEGION_FSYNC` 改为 `always`。

```sh
./deploy/home/antlegion.sh status
./deploy/home/antlegion.sh logs
./deploy/home/antlegion.sh stop
./deploy/home/antlegion.sh demo       # 独立端口 28091 和独立卷
./deploy/home/antlegion.sh demo-stop  # 停止演示容器，保留演示卷
```

演示不需要模型或设备，Agent 通过真实 Bus 写入环境观察、判断、认领和模拟执行结果。演示控制台也可直接打开。每次运行会新增事实；演示数据不会写入正式卷。演示端口固定为 28091，需确保未被占用。

## 接入 Agent

```sh
export ANTLEGION_BUS_URL=http://127.0.0.1:28090
export ANTLEGION_AUTHOR='home-sensor'
alctl publish sys.registry '{"interests":["home.*"],"publishes":["home.environment.observed"]}'
alctl publish home.environment.observed '{"temperature_c":26}' --subject home:living-room:environment
alctl current home:living-room:environment
```

Node.js SDK：`new ClientV2(httpTransport(url), author)`。`sys.registry` 和定期 `sys.heartbeat` 是观察约定；近期有事实表示近期活动，并不证明进程在线。

## 备份和恢复

先运行 `stop`，再备份 `.env` 和卷。以下从仓库根目录运行，将生成的归档与 `.env` 一起存放在安全位置：

```sh
docker run --rm -v antlegion-home_data:/data:ro -v "$PWD":/backup alpine tar -czf /backup/antlegion-data.tar.gz -C /data .
```

恢复到新机器时，将原 `.env` 放回 `deploy/home/.env`，创建空卷并导入备份，再运行 `up`：

```sh
docker volume create antlegion-home_data
docker run --rm -v antlegion-home_data:/data -v "$PWD":/backup:ro alpine tar -xzf /backup/antlegion-data.tar.gz -C /data
./deploy/home/antlegion.sh up
```

只向空卷恢复；在已有数据的卷中解包可能覆盖现有日志。控制台服务信息的 `sig_failures` 应为 0。日志尾部若因异常中断而不完整，启动时会丢弃不完整尾部并报告 `recovered_tail_bytes`；完整记录损坏时会拒绝启动，以免悄悄跳过历史。

升级前先停止并备份卷与 `.env`，更新代码后运行 `up` 重新构建。需要回退时停止服务，恢复旧版本代码以及与之对应的备份。当前服务在内存中保存完整事实流，适合单机和小规模使用。
