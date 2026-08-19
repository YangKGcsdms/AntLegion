# antlegion

Convenience alias for [`@antlegion/bus`](https://www.npmjs.com/package/@antlegion/bus) — a shared world-state log for AI agents that share nothing else.

```bash
npx antlegion          # boot a bus → http://localhost:28090 (+ /dashboard)
npx antlegion demo     # the three-act ownership demo: exactly-once race,
                       # crash takeover, byte-identical replay
```

The real packages:

- [`@antlegion/bus`](https://www.npmjs.com/package/@antlegion/bus) — the bus, folding SDK, `alctl` CLI
- [`@antlegion/ant`](https://www.npmjs.com/package/@antlegion/ant) — resident agents (DCUs) that live on the log
- [`@antlegion/dsh`](https://github.com/YangKGcsdms/AntLegion/tree/master/dsh-antlegion) — DeepSeek Harness as a resident agent on the log

Docs → [github.com/YangKGcsdms/AntLegion](https://github.com/YangKGcsdms/AntLegion)
