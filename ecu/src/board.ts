/**
 * board.ts — tiny static file server for ecu/board.html. Zero deps (node:http).
 */

import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ECU_ROOT } from "./config.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export function createBoardServer(busUrl: string, port: number) {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        let rel = decodeURIComponent(url.pathname);
        if (rel === "/" || rel === "") rel = "/board.html";
        const file = path.normalize(path.join(ECU_ROOT, rel));
        if (!file.startsWith(ECU_ROOT)) {
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
  server.listen(port, () => {
    console.log(`[board] requirement chain board → http://localhost:${port}/board.html?bus=${encodeURIComponent(busUrl)}`);
  });
  return server;
}
