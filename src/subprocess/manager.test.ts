import assert from "node:assert/strict";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import type { ClaudeCliResult } from "../types/claude-cli.js";
import { ClaudeSubprocess } from "./manager.js";

const OPTIONS = { model: "haiku" as const, timeout: 2_000 };
const SUCCESS_RESULT: ClaudeCliResult = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1,
  duration_api_ms: 1,
  num_turns: 1,
  result: "hello 🌍",
  session_id: "fake-session",
  total_cost_usd: 0,
  usage: { input_tokens: 2, output_tokens: 3 },
  modelUsage: {
    "claude-haiku-4-5": { inputTokens: 2, outputTokens: 3, costUSD: 0 },
  },
};

function createNodeBackedSubprocess(source: string): ClaudeSubprocess {
  const fakeSpawn = ((
    _command: string,
    _args: readonly string[],
    options: Parameters<typeof nodeSpawn>[2]
  ) => nodeSpawn(process.execPath, ["--eval", source], options)) as typeof nodeSpawn;

  const InjectableClaudeSubprocess = ClaudeSubprocess as unknown as new (
    spawnProcess: typeof nodeSpawn
  ) => ClaudeSubprocess;
  return new InjectableClaudeSubprocess(fakeSpawn);
}

function waitForResult(
  subprocess: ClaudeSubprocess,
  timeoutMs = 1_000
): Promise<ClaudeCliResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for a Claude result")),
      timeoutMs
    );

    subprocess.once("result", (result: ClaudeCliResult) => {
      clearTimeout(timeout);
      resolve(result);
    });
    subprocess.once("error", (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe("ClaudeSubprocess reliability", { concurrency: false }, () => {
  let originalClaudeBin: string | undefined;

  before(() => {
    originalClaudeBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = path.join(
      tmpdir(),
      "definitely-missing-claude-command"
    );
  });

  after(() => {
    if (originalClaudeBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = originalClaudeBin;
  });

  it("rejects start when the configured Claude executable does not exist", async () => {
    const subprocess = new ClaudeSubprocess();
    await assert.rejects(
      subprocess.start("hello", OPTIONS),
      /Claude CLI not found/
    );
  });

  it("parses the final JSON record when stdout has no trailing newline", async () => {
    const payload = JSON.stringify(SUCCESS_RESULT);
    const subprocess = createNodeBackedSubprocess(
      `process.stdout.write(${JSON.stringify(payload)});`
    );
    const resultPromise = waitForResult(subprocess);

    await subprocess.start("hello", OPTIONS);
    const result = await resultPromise;

    assert.equal(result.subtype, "success");
    assert.equal(result.result, "hello 🌍");
  });

  it("preserves UTF-8 characters split across stdout chunks", async () => {
    const payload = JSON.stringify(SUCCESS_RESULT);
    const bytes = Buffer.from(payload, "utf8");
    const splitAt = bytes.indexOf(Buffer.from("🌍", "utf8")) + 1;
    const source = [
      `const bytes = Buffer.from(${JSON.stringify(payload)}, "utf8");`,
      `process.stdout.write(bytes.subarray(0, ${splitAt}));`,
      `setTimeout(() => { process.stdout.write(bytes.subarray(${splitAt})); process.stdout.write("\\n"); }, 40);`,
    ].join("\n");
    const subprocess = createNodeBackedSubprocess(source);
    const resultPromise = waitForResult(subprocess);

    await subprocess.start("hello", OPTIONS);
    const result = await resultPromise;

    assert.equal(result.result, "hello 🌍");
  });

  it("propagates stdin EOF errors instead of leaving them uncaught", async () => {
    let child: ChildProcess | null = null;
    let stdinError: Error | null = null;
    const fakeSpawn = ((
      _command: string,
      _args: readonly string[],
      options: Parameters<typeof nodeSpawn>[2]
    ) => {
      child = nodeSpawn(
        process.execPath,
        ["--eval", "process.exit(1)"],
        options
      );
      child.stdin?.on("error", (error) => {
        stdinError = error;
      });
      return child;
    }) as typeof nodeSpawn;
    const InjectableClaudeSubprocess = ClaudeSubprocess as unknown as new (
      spawnProcess: typeof nodeSpawn
    ) => ClaudeSubprocess;
    const subprocess = new InjectableClaudeSubprocess(fakeSpawn);
    const managerErrors: Error[] = [];
    subprocess.on("error", (error: Error) => managerErrors.push(error));
    const closed = new Promise<void>((resolve) => {
      subprocess.once("close", () => resolve());
    });

    await subprocess.start("x".repeat(10_000_000), OPTIONS);
    await closed;

    const capturedStdinError = stdinError as Error | null;
    assert.ok(capturedStdinError, "fixture should produce a stdin write error");
    assert.match(capturedStdinError.message, /EOF|EPIPE|broken pipe/i);
    assert.equal(managerErrors.length, 1);
    assert.equal(managerErrors[0], capturedStdinError);
  });

  it("honors cancellation requested before the child emits spawn", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let prompt = "";
    let killCalls = 0;
    stdin.on("data", (chunk: Buffer) => {
      prompt += chunk.toString();
    });

    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      pid: undefined,
      exitCode: null,
      signalCode: null,
      kill: (_signal?: NodeJS.Signals) => {
        killCalls++;
        return killCalls > 1;
      },
    }) as unknown as ChildProcess;
    const fakeSpawn = (() => {
      setTimeout(() => child.emit("spawn"), 30);
      return child;
    }) as unknown as typeof nodeSpawn;
    const InjectableClaudeSubprocess = ClaudeSubprocess as unknown as new (
      spawnProcess: typeof nodeSpawn
    ) => ClaudeSubprocess;
    const subprocess = new InjectableClaudeSubprocess(fakeSpawn);

    const started = subprocess.start("must not be written", OPTIONS);
    subprocess.kill("SIGTERM");
    await started;

    assert.equal(prompt, "");
    assert.equal(killCalls, 2, "kill should be retried after spawn");
  });

});
