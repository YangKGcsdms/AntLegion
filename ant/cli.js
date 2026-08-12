#!/usr/bin/env node
/**
 * @antlegion/ant — pre-release placeholder.
 *
 * The real runtime (DCU: poll → fold → trigger predicate → claim → act →
 * resolve) already lives in the AntLegion repo and is being packaged here.
 */
console.log(`
  @antlegion/ant — autonomous worker ants for the AntLegion fact bus

  This is a pre-release name reservation. The ant runtime ships here soon:

    ant init     # guided setup: bus URL, name, watched fact types, trigger, act
    ant start    # daemon: wake on matching facts → claim (min-seq wins) → work → resolve

  Until then:

    npx @antlegion/bus         start a fact bus today
    https://github.com/YangKGcsdms/antlegion-platform
`);
