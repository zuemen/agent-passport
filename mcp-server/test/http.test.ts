import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { checkRequest, startHttp } from "../src/http.js";

const opts = { allowedHosts: ["localhost", "127.0.0.1"], allowedOrigins: ["https://app.example"] };

describe("HTTP transport guards", () => {
  it("rejects foreign Host headers (DNS rebinding)", () => {
    expect(checkRequest({ headers: { host: "evil.example:18791" } }, opts)).toMatchObject({ status: 403 });
    expect(checkRequest({ headers: { host: "127.0.0.1:18791" } }, opts)).toBeUndefined();
  });

  it("rejects Origins that are not allowed", () => {
    expect(checkRequest({ headers: { host: "localhost", origin: "https://evil.example" } }, opts)).toMatchObject({ status: 403 });
    expect(checkRequest({ headers: { host: "localhost", origin: "https://app.example" } }, opts)).toBeUndefined();
  });

  it("requires the bearer token when one is configured", () => {
    const t = { ...opts, token: "s3cret-token" };
    expect(checkRequest({ headers: { host: "localhost" } }, t)).toMatchObject({ status: 401 });
    expect(checkRequest({ headers: { host: "localhost", authorization: "Bearer wrong-token!" } }, t)).toMatchObject({ status: 401 });
    expect(checkRequest({ headers: { host: "localhost", authorization: "Bearer s3cret-token" } }, t)).toBeUndefined();
  });
});

describe("Streamable HTTP server", () => {
  let server: Server;
  beforeAll(() => {
    delete process.env.PASSPORT_HTTP_TOKEN;
    server = startHttp(18791);
  });
  afterAll(() => server.close());

  it("without a token it is verifier-only, over a real MCP session", async () => {
    const cl = new Client({ name: "remote-verifier", version: "0" });
    await cl.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:18791/mcp")));
    const { tools } = await cl.listTools();
    expect(tools.map((t) => t.name)).toEqual(["verify_passport"]);
    await cl.close();
  });

  it("answers 403 to a cross-origin browser request", async () => {
    const res = await fetch("http://127.0.0.1:18791/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", origin: "https://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(403);
  });
});
