🌐 **English** · [简体中文](CONFIGURATION.zh-CN.md)

# Configuration & operations

The bus is configured entirely by environment variables — the `redis.conf` analog, resolved in [`antlegion-bus/src/config.ts`](../antlegion-bus/src/config.ts). There is no config file to manage and no state beyond the journal.

## Environment variables

| Environment variable | Default | Notes |
|---|---|---|
| `PORT` | `28090` | HTTP listen port |
| `HOST` | `127.0.0.1` | Listen address — the bus trusts its callers (same security model as Redis); set `0.0.0.0` only inside a trust boundary |
| `ANTLEGION_DATA_DIR` | `.data-v2` | Directory for the journal file (`facts-v2.jsonl`) |
| `ANTLEGION_FSYNC` | `everysec` | `always` (max durability) · `everysec` (≤1s loss) · `no` (OS decides) — mirrors Redis `appendfsync` |
| `ANTLEGION_BUS_SECRET` | *(random each boot)* | HMAC signing secret. **Always set a stable value in production** — without it, signatures written before a restart cannot be verified |
| `ANTLEGION_MAX_DEPTH` | `64` | Maximum causation chain depth (§5 safety cap; cycles are structurally impossible under content addressing) |

```bash
# Production-style invocation
ANTLEGION_BUS_SECRET=a-stable-32-char-secret \
ANTLEGION_DATA_DIR=/var/lib/antlegion \
ANTLEGION_FSYNC=always \
node dist/index.js
```

Clients and the CLI read `ANTLEGION_BUS_URL` (default `http://localhost:28090`) to find the bus, and `ANTLEGION_AUTHOR` for a stable agent identity — see [AGENT-CLI.md](AGENT-CLI.md).

## Ways to run it

**Foreground** (development):

```bash
npx @antlegion/bus
```

**As a daemon** (redis-server style — pidfile + log live next to the journal):

```bash
npm i -g @antlegion/bus
antlegion start     # detached
antlegion status    # pid · /health · file locations
antlegion stop      # SIGTERM — the journal is flushed on exit
```

**Docker** — one process, one volume; the journal and nothing else lives in `/data`:

```bash
docker run -d --name antlegion -p 28090:28090 \
  -v antlegion-data:/data -e ANTLEGION_BUS_SECRET=change-me \
  ghcr.io/yangkgcsdms/antlegion
```

The image binds `0.0.0.0` inside the container (the docker network is the trust boundary); publish the port only where you trust the callers. To build it yourself, from the repo root: `docker build -t antlegion .` — see [DOCKER-VERIFY.md](DOCKER-VERIFY.md) for the end-to-end container check.

**From source** (development):

```bash
git clone https://github.com/YangKGcsdms/AntLegion.git
cd AntLegion/antlegion-bus
npm install && npm run dev
```

## Ops cheat sheet

- **Where's my data?** One append-only file: `$ANTLEGION_DATA_DIR/facts-v2.jsonl` (default `.data-v2/`). Back it up by copying it.
- **Start fresh:** stop the bus, delete the data dir. There is no other state anywhere.
- **Ctrl-C is safe:** the journal is flushed on shutdown; recovery replays the log and verifies every signature.
- **Always set a stable `ANTLEGION_BUS_SECRET`:** unset, the bus mints a fresh HMAC key each boot — after a restart, `sig`s written earlier can no longer be verified (they surface as `sig_failures` in `/info`).

## Security model

Same trust boundary as Redis: the bus **trusts its callers**. It binds to `127.0.0.1` by default; set `HOST=0.0.0.0` only inside a boundary you control (a docker network, a VPC). There is no authentication yet — do not expose it to untrusted networks.

## Troubleshooting

| symptom | cause / fix |
|---|---|
| `error: port 28090 already in use` | another bus is running — reuse it, or `PORT=28091 npx @antlegion/bus` |
| `sig_failures > 0` in `/info` | the bus restarted with a different (or missing) `ANTLEGION_BUS_SECRET` — set a stable one |
| `error: cannot reach bus at <url>` from alctl/SDK | no bus on that URL — `npx @antlegion/bus`, or point `ANTLEGION_BUS_URL` at the right host |
| `resolve ignored — fact is owned by 'X'` | you lost the claim; that's the system working. Query state, pick other work |
| two units act on the same task | are two processes sharing one identity/author? one identity = one process ([why](../research/s2-experiments-2026-08.md)) |
