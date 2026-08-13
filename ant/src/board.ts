/**
 * board.ts — tiny static file server for the package's board pages. Zero deps (node:http).
 *
 * Security posture (see .cowork/03-deepseek-review核验.md H2):
 *  - Only an explicit allowlist of pages is served (board.html, devchain.html) —
 *    never "any file under PKG_ROOT". This alone defeats path traversal, since a
 *    request for a sibling-package source file is not in the allowlist.
 *  - Defense in depth: even the allowlisted path is re-checked against a
 *    `PKG_ROOT + path.sep` boundary (a plain `startsWith(PKG_ROOT)` lets
 *    `.../antlegion-bus/x` pass because it shares the `ant` prefix — the original
 *    bug; a `%2e%2e`-encoded `..` survives `new URL()` and decodes after).
 *  - Binds to 127.0.0.1 by default (HOST overrides), matching the bus core: the
 *    board serves local files and must not be exposed beyond loopback by accident.
 */

import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PKG_ROOT } from "./config.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** The only pages this server will ever return. Requests for anything else 404. */
const ALLOWED_PAGES = new Set(["board.html", "devchain.html"]);

export function createBoardServer(busUrl: string, port: number) {
  const host = process.env.HOST || "127.0.0.1";
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        let rel = decodeURIComponent(url.pathname);
        if (rel === "/" || rel === "") rel = "/board.html";
        const name = rel.replace(/^\/+/, ""); // strip leading slash(es) → basename candidate
        // Allowlist gate: reject anything that isn't one of the known pages
        // (also rejects any traversal attempt, since "../x" ∉ ALLOWED_PAGES).
        if (!ALLOWED_PAGES.has(name)) {
          res.writeHead(404).end("not found");
          return;
        }
        const file = path.normalize(path.join(PKG_ROOT, name));
        // Defense in depth: a real path-boundary check (not a bare prefix).
        if (file !== PKG_ROOT && !file.startsWith(PKG_ROOT + path.sep)) {
          res.writeHead(403).end("forbidden");
          return;
        }
        const body = await fs.readFile(file);
        res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
    })();
  });
  server.listen(port, host, () => {
    console.log(`[board] requirement chain board → http://${host}:${port}/board.html?bus=${encodeURIComponent(busUrl)}`);
  });
  return server;
}
