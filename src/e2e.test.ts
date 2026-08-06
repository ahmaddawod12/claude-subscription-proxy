/**
 * Live end-to-end tests for the Claude Max API proxy.
 *
 * These tests invoke the real Claude CLI and therefore require an authenticated
 * Claude subscription. They are deliberately skipped by the default `npm test`.
 * Run them explicitly with: npm run test:e2e
 */

import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { startServer, stopServer } from "./server/index.js";

const TEST_TIMEOUT = 120_000;
const RUN_LIVE_E2E = process.env.npm_lifecycle_event === "test:e2e";
const LIVE_TEST_OPTIONS = {
  skip: RUN_LIVE_E2E
    ? false
    : "requires an authenticated Claude subscription; run npm run test:e2e",
};

describe(
  "Claude subscription e2e",
  { timeout: TEST_TIMEOUT },
  () => {
    let baseUrl: string;
    let server: Server;

    if (RUN_LIVE_E2E) {
      console.warn("\n" + "=".repeat(70));
      console.warn("  WARNING: THIS TEST INVOKES THE REAL CLAUDE CODE CLI");
      console.warn("  IT WILL USE YOUR CLAUDE SUBSCRIPTION");
      console.warn("=".repeat(70) + "\n");
    }

    before(async () => {
      if (!RUN_LIVE_E2E) return;
      server = await startServer({ port: 0 });
      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
    });

    after(async () => {
      if (!RUN_LIVE_E2E) return;
      await stopServer();
    });

    describe("non-streaming completion", () => {
      it("returns a valid OpenAI response for a simple prompt", LIVE_TEST_OPTIONS, async () => {
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-haiku-4",
            stream: false,
            messages: [
              {
                role: "user",
                content: "Reply with exactly the word 'pong' and nothing else.",
              },
            ],
          }),
        });

        assert.equal(response.status, 200);
        const body = (await response.json()) as any;

        assert.ok(body.id, "missing id");
        assert.equal(body.object, "chat.completion");
        assert.ok(typeof body.created === "number");
        assert.ok(body.model, "missing model");
        assert.ok(Array.isArray(body.choices));
        assert.equal(body.choices.length, 1);
        const choice = body.choices[0];
        assert.equal(choice.index, 0);
        assert.equal(choice.finish_reason, "stop");
        assert.equal(choice.message.role, "assistant");
        assert.ok(typeof choice.message.content === "string");
        assert.ok(choice.message.content.length > 0, "empty content");
        assert.ok(body.usage, "missing usage");
        assert.ok(typeof body.usage.prompt_tokens === "number");
        assert.ok(typeof body.usage.completion_tokens === "number");
        assert.ok(typeof body.usage.total_tokens === "number");
        assert.ok(body.usage.prompt_tokens > 0, "prompt_tokens should be > 0");
        assert.ok(body.usage.total_tokens > 0, "total_tokens should be > 0");
      });

      it("handles array-style content blocks", LIVE_TEST_OPTIONS, async () => {
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "haiku",
            stream: false,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "Reply with exactly 'ok'." }],
              },
            ],
          }),
        });

        assert.equal(response.status, 200);
        const body = (await response.json()) as any;
        assert.ok(body.choices[0].message.content.length > 0);
      });
    });

    describe("streaming completion", () => {
      it("returns valid SSE chunks with usage in the final chunk", LIVE_TEST_OPTIONS, async () => {
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-haiku-4",
            stream: true,
            messages: [
              {
                role: "user",
                content: "Reply with exactly the word 'pong' and nothing else.",
              },
            ],
          }),
        });

        assert.equal(response.status, 200);
        assert.ok(
          response.headers.get("content-type")?.includes("text/event-stream"),
          "expected text/event-stream content type"
        );

        const lines = (await response.text()).split("\n");
        const chunks: any[] = [];
        let gotDone = false;

        for (const line of lines) {
          if (line === "data: [DONE]") {
            gotDone = true;
          } else if (line.startsWith("data: ")) {
            chunks.push(JSON.parse(line.slice(6)));
          }
        }

        assert.ok(gotDone, "stream should end with [DONE]");
        assert.ok(chunks.length >= 1, "should have at least one chunk");
        assert.ok(
          chunks.some((chunk) => chunk.choices?.[0]?.delta?.role === "assistant"),
          "first content chunk should set role to assistant"
        );

        for (const chunk of chunks) {
          assert.ok(chunk.id, "chunk missing id");
          assert.equal(chunk.object, "chat.completion.chunk");
          assert.ok(typeof chunk.created === "number");
          assert.ok(chunk.model, "chunk missing model");
          assert.ok(Array.isArray(chunk.choices));
          assert.equal(chunk.choices.length, 1);
        }

        const lastChunk = chunks[chunks.length - 1];
        assert.equal(lastChunk.choices[0].finish_reason, "stop");
        assert.ok(lastChunk.usage, "final chunk should include usage");
        assert.ok(typeof lastChunk.usage.prompt_tokens === "number");
        assert.ok(typeof lastChunk.usage.completion_tokens === "number");
        assert.ok(typeof lastChunk.usage.total_tokens === "number");

        const fullText = chunks
          .map((chunk) => chunk.choices[0].delta.content || "")
          .join("");
        assert.ok(fullText.length > 0, "streamed text should be non-empty");
      });
    });
  }
);
