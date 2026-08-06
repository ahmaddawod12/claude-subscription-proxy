import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { getServer, startServer, stopServer } from "./server/index.js";

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("offline HTTP contract", { concurrency: false }, () => {
  let baseUrl: string;
  let originalClaudeBin: string | undefined;

  before(async () => {
    originalClaudeBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = path.join(
      tmpdir(),
      "claude-proxy-offline-tests-no-cli"
    );
    const server = await startServer({ port: 0 });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    try {
      await stopServer();
    } finally {
      if (originalClaudeBin === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = originalClaudeBin;
    }
  });

  it("GET /health returns provider status", async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);

    const body = (await response.json()) as any;
    assert.equal(body.status, "ok");
    assert.equal(body.provider, "claude-code-cli");
    assert.ok(body.timestamp);
  });

  it("GET /v1/models lists every supported model ID", async () => {
    const response = await fetch(`${baseUrl}/v1/models`);
    assert.equal(response.status, 200);

    const body = (await response.json()) as any;
    assert.equal(body.object, "list");
    assert.ok(Array.isArray(body.data));

    const ids = body.data.map((model: any) => model.id);
    for (const expected of [
      "claude-opus-4",
      "claude-opus-4-6",
      "claude-sonnet-4",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-haiku-4",
      "claude-haiku-4-5",
    ]) {
      assert.ok(ids.includes(expected), `missing model ${expected}`);
    }

    for (const model of body.data) {
      assert.equal(model.object, "model");
      assert.equal(model.owned_by, "anthropic");
      assert.ok(typeof model.created === "number");
    }
  });

  it("returns an OpenAI-style 404 for an unknown route", async () => {
    const response = await fetch(`${baseUrl}/v1/nonexistent`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as any;
    assert.equal(body.error.code, "not_found");
  });

  it("rejects an empty messages array without invoking Claude", async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "haiku", messages: [] }),
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as any;
    assert.equal(body.error.type, "invalid_request_error");
    assert.equal(body.error.code, "invalid_messages");
  });

  it("returns a stable 400 response for malformed JSON", async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as any;
    assert.deepEqual(body, {
      error: {
        message: "Request body contains invalid JSON",
        type: "invalid_request_error",
        code: "invalid_json",
      },
    });
  });

  it("rejects a JSON null body instead of leaving the request hanging", async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
      signal: AbortSignal.timeout(1_000),
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as any;
    assert.equal(body.error.code, "invalid_messages");
  });
});

describe("server lifecycle", { concurrency: false }, () => {
  it("can start normally after a port binding failure", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });

    try {
      const port = (blocker.address() as AddressInfo).port;
      await assert.rejects(startServer({ port }), /already in use/);
      await closeServer(blocker);

      const recovered = await startServer({ port: 0 });
      assert.equal(recovered.listening, true);
      assert.ok(recovered.address(), "recovered server should have an address");
    } finally {
      await closeServer(blocker);
      await stopServer().catch(() => undefined);
    }
  });

  it("makes concurrent starters wait for the server to listen", async () => {
    const firstStart = startServer({ port: 0 });

    try {
      const secondServer = await startServer({ port: 0 });
      assert.equal(secondServer.listening, true);
      assert.ok(secondServer.address(), "server should be bound before start resolves");
      assert.equal(await firstStart, secondServer);
    } finally {
      await firstStart.catch(() => undefined);
      await stopServer().catch(() => undefined);
    }
  });

  it("does not leak a server when stop is called during startup", async () => {
    const start = startServer({ port: 0 });
    let startedServer: Server | null = null;

    try {
      await stopServer();
      startedServer = await start;
      assert.equal(startedServer.listening, false);
      assert.equal(getServer(), null);
    } finally {
      startedServer ??= await start.catch(() => null);
      if (startedServer) await closeServer(startedServer);
      await stopServer().catch(() => undefined);
    }
  });

  it("waits for shutdown before starting a replacement server", async () => {
    const originalServer = await startServer({ port: 0 });
    const stopping = stopServer();

    try {
      const replacement = await startServer({ port: 0 });
      await stopping;

      assert.notEqual(replacement, originalServer);
      assert.equal(originalServer.listening, false);
      assert.equal(replacement.listening, true);
      assert.equal(getServer(), replacement);
    } finally {
      await stopping.catch(() => undefined);
      await stopServer().catch(() => undefined);
    }
  });

  it("shares one shutdown operation between concurrent stoppers", async () => {
    const server = await startServer({ port: 0 });

    try {
      const firstStop = stopServer();
      const secondStop = stopServer();
      await Promise.all([firstStop, secondStop]);

      assert.equal(server.listening, false);
      assert.equal(getServer(), null);
    } finally {
      await stopServer().catch(() => undefined);
    }
  });
});
