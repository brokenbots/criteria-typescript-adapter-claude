import { TestHost } from "@criteria/adapter-sdk/testing";
import { describe, it, expect } from "bun:test";

describe("claude adapter", () => {
  it("opens a session and finalizes an outcome", async () => {
    const host = new TestHost({ binary: "./out/adapter-linux-amd64" });
    await host.openSession({
      config: { model: "claude-sonnet-4-6", max_turns: "3" },
      secrets: { ANTHROPIC_API_KEY: "sk-test-key" },
    });

    const result = await host.execute({
      step: "analyze",
      input: { prompt: "Test prompt" },
      allowed_outcomes: ["success", "failure"],
    });

    expect(result.outcome).toBeOneOf(["success", "failure", "needs_review"]);
  });

  it("rejects missing ANTHROPIC_API_KEY", async () => {
    const host = new TestHost({ binary: "./out/adapter-linux-amd64" });
    await expect(
      host.openSession({
        config: {},
        secrets: {},
      })
    ).rejects.toThrow("ANTHROPIC_API_KEY");
  });

  it("serializes and restores session state", async () => {
    const host = new TestHost({ binary: "./out/adapter-linux-amd64" });
    await host.openSession({
      config: { model: "claude-sonnet-4-6" },
      secrets: { ANTHROPIC_API_KEY: "sk-test-key" },
    });

    const snapshot = await host.snapshot();
    expect(snapshot.schema_version).toBe(1);
    expect(snapshot.state).toBeDefined();

    // Restore into a fresh session
    const host2 = new TestHost({ binary: "./out/adapter-linux-amd64" });
    await host2.restore(snapshot);
  });
});
