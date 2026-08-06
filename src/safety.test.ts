import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

it(
  "keeps the default test lifecycle offline even when RUN_CLAUDE_E2E is inherited",
  { timeout: 10_000 },
  async () => {
    const compiledDirectory = path.dirname(fileURLToPath(import.meta.url));
    const e2eTest = path.join(compiledDirectory, "e2e.test.js");
    const missingClaude = path.join(tmpdir(), "claude-must-not-run-in-npm-test");
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--test", e2eTest], {
      env: {
        ...childEnvironment,
        npm_lifecycle_event: "test",
        RUN_CLAUDE_E2E: "1",
        CLAUDE_BIN: missingClaude,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    assert.equal(exitCode, 0, output);
    assert.match(output, /skipped 3/);
  }
);
