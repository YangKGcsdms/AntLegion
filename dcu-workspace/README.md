# dcu-workspace — AntLegion native requirement workspace (dogfooding)

Requirements here are created natively by the DCU system:

    cd ant && npx tsx src/main.ts req new "<名称>" -s <slug>

Layout per requirement: `<yyyymmddHHMM>-<slug>/{dcu.env, docs/, logs/}`.
Requirement dirs are **local-only** — `.gitignore` keeps `2*/` out of the public
repo (see commit 50f4308); only this README is tracked. Plans, delivery reports
and logs stay on the machine that ran the work.
