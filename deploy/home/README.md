# Home fact bus: Docker deployment

Requires Linux or NAS, Docker and Docker Compose. From the repository root:

```sh
./deploy/home/antlegion.sh up
```

Open `http://127.0.0.1:28090/console` and enter the password shown by `./deploy/home/antlegion.sh password`. The generated password is `ANTLEGION_API_TOKEN` in `deploy/home/.env` and is shared with API clients; it does not identify individual users. The file also contains the stable signing secret. Keep and back it up; changing the signing secret makes previous signatures unverifiable. The default binding is loopback.

For trusted LAN access, set `ANTLEGION_BIND=0.0.0.0` in `.env`, run `up` again and connect to the NAS address. HTTP does not encrypt the token; use HTTPS or a VPN outside a trusted LAN. The default `everysec` fsync can lose recent unsynced writes on a crash; `ANTLEGION_FSYNC=always` trades speed for durability.

```sh
./deploy/home/antlegion.sh status
./deploy/home/antlegion.sh password   # show the password on the host
./deploy/home/antlegion.sh logs
./deploy/home/antlegion.sh stop
./deploy/home/antlegion.sh demo       # separate port 28091 and data volume
./deploy/home/antlegion.sh demo-stop  # keep demo volume
```

The demo needs no model or devices. Agents append real observations, a conclusion, competing claims and simulated device state to the isolated bus. Use the same token in the demo console. Each run adds facts. Port 28091 must be free.

## Connect an agent

```sh
export ANTLEGION_BUS_URL=http://127.0.0.1:28090
export ANTLEGION_API_TOKEN='your-token'
export ANTLEGION_AUTHOR='home-sensor'
alctl publish sys.registry '{"interests":["home.*"],"publishes":["home.environment.observed"]}'
alctl publish home.environment.observed '{"temperature_c":26}' --subject home:living-room:environment
alctl current home:living-room:environment
```

For Node.js, use `new ClientV2(httpTransport(url, { token }), author)`. HTTP uses `Authorization: Bearer <token>`. Registration and periodic `sys.heartbeat` are observation conventions; recent facts indicate activity, not a persistent connection. The shared token is not bound to an author identity.

## Backup and restore

Stop the bus first and save both `.env` and the data volume. From the repository root:

```sh
docker run --rm -v antlegion-home_data:/data:ro -v "$PWD":/backup alpine tar -czf /backup/antlegion-data.tar.gz -C /data .
```

On the new machine put the original `.env` in `deploy/home/.env` and restore to an empty volume:

```sh
docker volume create antlegion-home_data
docker run --rm -v antlegion-home_data:/data -v "$PWD":/backup:ro alpine tar -xzf /backup/antlegion-data.tar.gz -C /data
./deploy/home/antlegion.sh up
```

Restoring over an existing volume may overwrite its log. Check that `sig_failures` is zero in the console. A torn final record is removed on recovery and reported as `recovered_tail_bytes`; a corrupt complete record prevents startup. Before upgrading, stop and back up both files, update the source and run `up`. To roll back, stop and restore matching old source and backup. The full stream is kept in memory, so this deployment targets a single machine and small installations.
