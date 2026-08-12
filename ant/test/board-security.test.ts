/**
 * board-security.test.ts — review H2 regression.
 *
 * The board server must only ever return its allowlisted pages, must reject
 * `%2e%2e`-encoded path traversal (which survives new URL() and decodes to
 * `..` after), and must bind to loopback by default.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import { createBoardServer } from "../src/board.js";

let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

async function boot(): Promise<string> {
  server = createBoardServer("http://localhost:28090", 0); // port 0 → ephemeral
  await new Promise<void>((res) => server!.on("listening", () => res()));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("board server security (H2)", () => {
  it("serves the allowlisted board.html at /", async () => {
    const base = await boot();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<"); // real HTML body
  });

  it("serves devchain.html (the only other allowlisted page)", async () => {
    const base = await boot();
    expect((await fetch(`${base}/devchain.html`)).status).toBe(200);
  });

  it("404s a non-allowlisted file under the package root", async () => {
    const base = await boot();
    expect((await fetch(`${base}/package.json`)).status).toBe(404);
  });

  it("rejects %2e%2e-encoded traversal to a sibling package (the original CVE path)", async () => {
    const base = await boot();
    // %2e%2e decodes to ".." only AFTER new URL() normalization — the exact bypass.
    for (const p of [
      "/%2e%2e/antlegion-bus/package.json",
      "/%2e%2e%2f%2e%2e%2fpackage.json",
      "/../antlegion-bus/package.json",
    ]) {
      const res = await fetch(`${base}${p}`);
      expect([403, 404], p).toContain(res.status);
      // and crucially never leaks a sibling package's content
      if (res.status === 200) throw new Error(`traversal leaked via ${p}`);
    }
  });

  it("binds to loopback by default (address is 127.0.0.1)", async () => {
    await boot();
    const addr = server!.address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
  });
});
