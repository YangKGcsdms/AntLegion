# dcu-workspace — AntLegion native requirement workspace (dogfooding)

Requirements here are created natively by the DCU system:

    cd ecu && npx tsx src/main.ts req new "<名称>" -s <slug>

Layout per requirement: `<yyyymmddHHMM>-<slug>/{dcu.env, docs/, logs/}`.
docs/ is git-tracked; logs/ is runtime noise and gitignored.
