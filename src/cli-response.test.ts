import assert from "node:assert/strict";
import childProcess, { spawn as originalSpawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type {
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "./types/claude-cli.js";

const SUCCESS_RESULT: ClaudeCliResult = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1,
  duration_api_ms: 1,
  num_turns: 1,
  result: "fake success 🌍",
  session_id: "fake-session",
  total_cost_usd: 0,
  usage: { input_tokens: 2, output_tokens: 3 },
  modelUsage: {
    "claude-haiku-4-5": { inputTokens: 2, outputTokens: 3, costUSD: 0 },
  },
};

const ERROR_RESULT: ClaudeCliResult = {
  ...SUCCESS_RESULT,
  subtype: "error",
  is_error: true,
  result: "fake Claude failure",
  usage: { input_tokens: 2, output_tokens: 0 },
};

const STREAM_DELTA: ClaudeCliStreamEvent = {
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "fake success 🌍" },
  },
  session_id: "fake-session",
  uuid: "fake-event",
};

describe("offline Claude response flow", { concurrency: false }, () => {
  const realSpawn = originalSpawn;
  let baseUrl: string;
  let stopServer: (() => Promise<void>) | null = null;
  let originalScenario: string | undefined;

  before(async () => {
    originalScenario = process.env.FAKE_CLAUDE_SCENARIO;
    const payloads = {
      error: JSON.stringify(ERROR_RESULT),
      success: JSON.stringify(SUCCESS_RESULT),
      stream: [JSON.stringify(STREAM_DELTA), JSON.stringify(SUCCESS_RESULT)].join(
        "\n"
      ),
    };
    const source = [
      `const payloads = ${JSON.stringify(payloads)};`,
      'const scenario = process.env.FAKE_CLAUDE_SCENARIO || "success";',
      "process.stdout.write(payloads[scenario] + \"\\n\");",
    ].join("\n");
    const fakeSpawn = ((
      _command: string,
      _args: readonly string[],
      options: Parameters<typeof realSpawn>[2]
    ) => realSpawn(process.execPath, ["--eval", source], options)) as typeof realSpawn;

    childProcess.spawn = fakeSpawn;
    syncBuiltinESMExports();

    const serverModulePath = "./server/index.js";
    const serverModule = await import(serverModulePath);
    stopServer = serverModule.stopServer;
    const server = await serverModule.startServer({ port: 0 });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    try {
      if (stopServer) await stopServer().catch(() => undefined);
    } finally {
      childProcess.spawn = realSpawn;
      syncBuiltinESMExports();
      if (originalScenario === undefined) {
        delete process.env.FAKE_CLAUDE_SCENARIO;
      } else {
        process.env.FAKE_CLAUDE_SCENARIO = originalScenario;
      }
    }
  });

  it("preserves the non-streaming success response", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "success";
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "haiku",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "fake success 🌍");
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.deepEqual(body.usage, {
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
    });
  });

  it("preserves streaming text, stop, and usage chunks", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "stream";
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "haiku",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    const lines = (await response.text()).split("\n");
    assert.ok(lines.includes("data: [DONE]"));
    const events = lines
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const text = events
      .map((event) => event.choices?.[0]?.delta?.content || "")
      .join("");
    const finalEvent = events[events.length - 1];

    assert.equal(text, "fake success 🌍");
    assert.equal(finalEvent.choices[0].finish_reason, "stop");
    assert.deepEqual(finalEvent.usage, {
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
    });
  });

  it("returns an HTTP error instead of a non-streaming completion", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "error";
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "haiku",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 500);
    const body = (await response.json()) as any;
    assert.equal(body.error.type, "server_error");
    assert.equal(body.error.message, "fake Claude failure");
    assert.equal(body.choices, undefined);
  });

  it("emits an SSE error instead of a normal streaming stop chunk", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "error";
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "haiku",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));

    assert.ok(
      events.some((event) => event.error?.message === "fake Claude failure"),
      "stream should contain the Claude error"
    );
    assert.ok(
      !events.some((event) => event.choices?.[0]?.finish_reason === "stop"),
      "error stream must not claim a normal stop"
    );
  });
});
