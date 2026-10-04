import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executePinnedHttpRequest } from "../services/plugin-host-services.js";

// Bytes that are not valid UTF-8: a UTF-8 decode would replace them with U+FFFD.
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80]);

describe("executePinnedHttpRequest binary mode", () => {
  let server: http.Server;
  let port = 0;
  let lastAuth: string | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastAuth = req.headers.authorization;
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.alloc(4096, 1));
        return;
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://127.0.0.1:1/x" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "image/png" });
      res.end(BINARY);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const target = (path: string) => ({
    parsedUrl: new URL(`http://files.example.test:${port}${path}`),
    resolvedAddress: "127.0.0.1",
    hostHeader: `files.example.test:${port}`,
    useTls: false,
  });

  it("returns the exact bytes base64-encoded and forwards headers", async () => {
    const result = await executePinnedHttpRequest(
      target("/a.png"),
      { headers: { Authorization: "Bearer t" } },
      new AbortController().signal,
      { binary: true },
    );
    expect(result.status).toBe(200);
    expect(Buffer.from(result.bodyBase64!, "base64").equals(BINARY)).toBe(true);
    expect(lastAuth).toBe("Bearer t");
  });

  it("text mode is unchanged (utf8 body, no bodyBase64)", async () => {
    const result = await executePinnedHttpRequest(target("/a.png"), undefined, new AbortController().signal);
    expect(result.bodyBase64).toBeUndefined();
    expect(typeof result.body).toBe("string");
  });

  it("aborts when the body exceeds maxBytes", async () => {
    await expect(
      executePinnedHttpRequest(target("/big"), undefined, new AbortController().signal, { binary: true, maxBytes: 1024 }),
    ).rejects.toThrow("exceeded 1024 bytes");
  });

  it("does not follow redirects (the bot token must not leave the validated host)", async () => {
    const result = await executePinnedHttpRequest(
      target("/redirect"),
      { headers: { Authorization: "Bearer t" } },
      new AbortController().signal,
      { binary: true },
    );
    expect(result.status).toBe(302);
  });
});
