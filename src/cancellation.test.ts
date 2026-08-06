import assert from "node:assert/strict";
import childProcess, {
  spawn as originalSpawn,
  type ChildProcess,
} from "node:child_process";
import { ServerResponse, type Server } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { it } from "node:test";

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("close", onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("close", onClose);
  });
}

it("kills a non-streaming Claude process when its client disconnects", async () => {
  const realSpawn = originalSpawn;
  let spawnedChild: ChildProcess | null = null;
  let server: Server | null = null;
  let stopServer: (() => Promise<void>) | null = null;
  let resolveSpawned!: (child: ChildProcess) => void;
  const childSpawned = new Promise<ChildProcess>((resolve) => {
    resolveSpawned = resolve;
  });

  const fakeSpawn = ((
    _command: string,
    _args: readonly string[],
    options: Parameters<typeof originalSpawn>[2]
  ) => {
    spawnedChild = realSpawn(
      process.execPath,
      ["--eval", "setInterval(() => {}, 1000)"],
      options
    );
    resolveSpawned(spawnedChild);
    return spawnedChild;
  }) as typeof originalSpawn;

  childProcess.spawn = fakeSpawn;
  syncBuiltinESMExports();

  try {
    const serverModulePath = "./server/index.js";
    const serverModule = await import(serverModulePath);
    stopServer = serverModule.stopServer;
    const startedServer = await serverModule.startServer({ port: 0 });
    server = startedServer;
    const address = startedServer.address() as AddressInfo;

    const controller = new AbortController();
    const request = fetch(
      `http://127.0.0.1:${address.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "haiku",
          messages: [{ role: "user", content: "hello" }],
        }),
        signal: controller.signal,
      }
    );

    const child = await Promise.race([
      childSpawned,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Claude process was not spawned")), 1_000)
      ),
    ]);
    controller.abort();
    await assert.rejects(request, /abort/i);

    assert.equal(
      await waitForExit(child, 750),
      true,
      "Claude child should exit promptly after the HTTP client disconnects"
    );
  } finally {
    if (
      spawnedChild &&
      (spawnedChild as ChildProcess).exitCode === null &&
      (spawnedChild as ChildProcess).signalCode === null
    ) {
      (spawnedChild as ChildProcess).kill("SIGTERM");
      await waitForExit(spawnedChild as ChildProcess, 1_000);
    }
    if (stopServer) await stopServer().catch(() => undefined);

    childProcess.spawn = realSpawn;
    syncBuiltinESMExports();
  }
});

it(
  "does not write queued streaming events after the client disconnects",
  { timeout: 5_000 },
  async () => {
    const realSpawn = originalSpawn;
    const originalWrite = ServerResponse.prototype.write;
    let spawnedChild: ChildProcess | null = null;
    let forceKillChild: ((signal?: NodeJS.Signals) => boolean) | null = null;
    let stopServer: (() => Promise<void>) | null = null;
    let writesAfterClose = 0;
    let resolveSpawned!: (child: ChildProcess) => void;
    const childSpawned = new Promise<ChildProcess>((resolve) => {
      resolveSpawned = resolve;
    });

    const delta = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "late text" },
      },
      session_id: "fake-session",
      uuid: "fake-delta",
    });
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: "late text",
      session_id: "fake-session",
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {
        "claude-haiku-4-5": { inputTokens: 1, outputTokens: 1, costUSD: 0 },
      },
    });
    const source = [
      `const payload = ${JSON.stringify(`${delta}\n${result}\n`)};`,
      "setTimeout(() => process.stdout.write(payload), 250);",
      "setTimeout(() => process.exit(0), 350);",
    ].join("\n");
    const fakeSpawn = ((
      _command: string,
      _args: readonly string[],
      options: Parameters<typeof originalSpawn>[2]
    ) => {
      const child = realSpawn(process.execPath, ["--eval", source], options);
      const realKill = child.kill.bind(child);
      forceKillChild = realKill;
      child.kill = (() => true) as typeof child.kill;
      spawnedChild = child;
      resolveSpawned(child);
      return child;
    }) as typeof originalSpawn;

    ServerResponse.prototype.write = function (
      this: ServerResponse,
      ...args: any[]
    ): boolean {
      if (this.destroyed) {
        writesAfterClose++;
        return false;
      }
      return originalWrite.apply(this, args as any);
    } as typeof originalWrite;
    childProcess.spawn = fakeSpawn;
    syncBuiltinESMExports();

    try {
      const serverModulePath = "./server/index.js";
      const serverModule = await import(serverModulePath);
      stopServer = serverModule.stopServer;
      const server = await serverModule.startServer({ port: 0 });
      const address = server.address() as AddressInfo;
      const controller = new AbortController();
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "haiku",
            stream: true,
            messages: [{ role: "user", content: "hello" }],
          }),
          signal: controller.signal,
        }
      );
      await childSpawned;
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));

      assert.equal(writesAfterClose, 0);
    } finally {
      ServerResponse.prototype.write = originalWrite;
      childProcess.spawn = realSpawn;
      syncBuiltinESMExports();
      const childToKill = spawnedChild as ChildProcess | null;
      const killChild = forceKillChild as
        | ((signal?: NodeJS.Signals) => boolean)
        | null;
      if (
        childToKill &&
        childToKill.exitCode === null &&
        childToKill.signalCode === null &&
        killChild
      ) {
        killChild("SIGTERM");
        await waitForExit(childToKill, 1_000);
      }
      if (stopServer) await stopServer().catch(() => undefined);
    }
  }
);
