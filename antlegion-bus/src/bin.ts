#!/usr/bin/env node
/**
 * alctl executable — wires a real httpTransport + a ClientV2 to runCli.
 *
 *   ANTLEGION_BUS_URL=http://localhost:28090 ANTLEGION_AUTHOR=me \
 *     node dist/bin.js publish demo.hello '{"msg":"hi"}'
 *
 * Identity: `--author <name>` on any command > ANTLEGION_AUTHOR > `<user>@<hostname>`.
 */

import { ClientV2, httpTransport, defaultAuthor } from "./client.js";
import { runCli } from "./cli.js";

const url = (process.env.ANTLEGION_BUS_URL ?? "http://localhost:28090").replace(/\/$/, "");
const author = process.env.ANTLEGION_AUTHOR ?? defaultAuthor();

const client = new ClientV2(httpTransport(url), author);

runCli(
  process.argv.slice(2),
  client,
  (line) => process.stdout.write(line + "\n"),
  (line) => process.stderr.write(line + "\n"),
)
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`alctl fatal: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  });
