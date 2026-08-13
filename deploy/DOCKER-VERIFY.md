# Docker: build, run, and verify the CLI event flow

The container is the bus; agents drive it from outside with the `alctl` CLI
(see `docs/AGENT-CLI.md`). This is the end-to-end check that a containerized bus
serves the full agent loop.

## 1. Build & run

```bash
docker build -t antlegion .                      # from the repo root
docker run -d --name antlegion-bus -p 28090:28090 \
  -e ANTLEGION_BUS_SECRET=your-stable-secret \
  -v antlegion-data:/data antlegion
curl -sf localhost:28090/health                  # {"status":"ok","protocol":"2.0",…}
open http://localhost:28090/console               # ops console (stream / colony / health)
```

`HOST=0.0.0.0` is baked into the image on purpose — a container is reached from
outside, and the docker network is the trust boundary (the bus trusts its
callers; do not expose it to untrusted networks).

**Always pass a stable `ANTLEGION_BUS_SECRET`.** Without it the bus mints a new
HMAC key each boot and signatures written before a restart stop verifying
(visible as `sig_failures > 0` in `/info`).

## 2. Verify the whole event flow through the CLI

```bash
ANTLEGION_BUS_URL=http://localhost:28090 node deploy/verify-cli-eventflow.mjs
```

Expected: **13 passed, 0 failed** — agent registration (`sys.registry`),
publish, exactly-once claim (one winner, loser exits 1), resolve, causation
child, two-observer trust consensus, orphan detection, the context
request/answer loop, and server-side query validation (400 on a junk `limit`).

Run it with no `ANTLEGION_BUS_URL` and it boots its own local bus instead —
handy for a quick check without Docker.

## 3. Restart persistence (AOF + signature integrity)

```bash
docker restart antlegion-bus && sleep 5
curl -s localhost:28090/info    # same head_seq/facts as before, sig_failures: 0
```

Facts survive the restart and every signature re-verifies, because the data dir
is a volume and the secret is stable.

## Troubleshooting: `docker pull` hangs (China / restricted networks)

If `docker build` or `docker pull node:20-alpine` stalls right after
`Using default tag: latest` with zero progress — while the daemon is otherwise
healthy and containers have working egress (`getent hosts registry-1.docker.io`
resolves, TCP 443 connects) — the daemon simply cannot reach the Docker Hub CDN.
Pull the base image from a mirror and retag it, then build normally:

```bash
docker pull docker.m.daocloud.io/library/node:20-alpine
docker tag docker.m.daocloud.io/library/node:20-alpine node:20-alpine
docker build -t antlegion .      # now resolves the base image locally
```

Other mirrors that work the same way: `docker.1panel.live`, `dockerpull.com`,
`hub.rat.dev`, `docker.nju.edu.cn` (all take `/library/<image>:<tag>`).
Alternatively configure `registry-mirrors` in the daemon config once.
