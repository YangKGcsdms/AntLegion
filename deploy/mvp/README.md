# AntLegion MVP — four containers, one command

One bus core + three pi-agent (DCU) containers on Ubuntu 24.04, coordinating
100 trigger→claim→act→resolve cycles through nothing but the fact stream.
Acts route through DeepSeek via pi-ai.

```bash
cd deploy/mvp
DEEPSEEK_API_KEY=sk-… docker compose up --build --exit-code-from mvp
```

The `mvp` runner feeds 25 requirements (→ 100 stage cycles), prints a live
`chains done N/25` ticker, and exits with the scoreboard once every chain
folds to done. `--exit-code-from mvp` tears the stack down afterwards.

| container | role | DCUs |
|---|---|---|
| `bus` | fact bus core (`@antlegion/bus`) | — |
| `ant-builder` | pi agent 1 | `dcu-plan` · `dcu-dev` |
| `ant-tester` | pi agent 2 | `dcu-unittest` · `dcu-e2e` |
| `ant-governor` | pi agent 3 | `dcu-adjudicator` · `dcu-watchdog` · `dcu-gate-approver` |

No container addresses another (the only wiring is the bus URL): builders
claim work the moment the shared fold says a stage is open, the governor
adjudicates every artifact's evidence shape and auto-approves gates, and
exactly-once is decided by lowest claim `seq` — the same theorem that lets
you `docker kill` an agent mid-run and watch a sibling take over.

Knobs (env):

| var | default | meaning |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | required for LLM acts |
| `ANT_WORKER` | `llm` | `simulated` runs without any API key |
| `ANT_LLM_MODEL` | `deepseek-v4-flash` | any model on the endpoint |
| `MVP_REQS` | `25` | requirements to feed (4 cycles each) |

Watch a specific agent: `docker compose logs -f ant-builder`.
