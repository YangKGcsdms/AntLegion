#!/usr/bin/env node
// antlegion — convenience alias for @antlegion/bus.
// `npx antlegion` boots the fact bus; `npx antlegion demo` runs the demo.
// The bus entry reads process.argv itself, so this is a pure passthrough.
import "@antlegion/bus";
