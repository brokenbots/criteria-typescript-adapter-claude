import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import { TestHost } from "@criteria/adapter-sdk/testing";

const mockCreate = mock();

mock.module("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      constructor(public opts: any) {}
      messages = { create: mockCreate };
    },
  };
});

let adapterConfig: any;

beforeAll(async () => {
  const mod = await import("../index.ts");
  adapterConfig = mod.adapterConfig;
});

afterAll(() => {
  mockCreate.mockClear();
});

function resetMock() {
  mockCreate.mockReset();
}

describe("claude adapter", () => {
  it("rejects missing ANTHROPIC_API_KEY on openSession", async () => {
    const host = new TestHost({ config: adapterConfig });
    await expect(
      host.openSession({ config: {}, secrets: {} })
    ).rejects.toThrow("ANTHROPIC_API_KEY");
    await host.stop();
  });

  it("executes and finalizes a success outcome via tool_use", async () => {
    resetMock();
    mockCreate.mockImplementationOnce(() => ({
      content: [
        {
          type: "tool_use",
          name: "submit_outcome",
          id: "tu1",
          input: { outcome: "success", reason: "done" },
        },
      ],
    }));

    const host = new TestHost({ config: adapterConfig });
    await host.openSession({
      config: { model: "claude-sonnet-4-6", max_turns: 3 },
      secrets: { ANTHROPIC_API_KEY: "sk-test" },
    });

    const result = await host.execute({
      stepName: "analyze",
      input: { prompt: "Test prompt" },
      allowedOutcomes: ["success", "failure"],
    });

    expect(result.outcome).toBe("success");
    expect(result.reason).toBe("done");
    await host.stop();
  });

  it("validates disallowed outcomes and recovers", async () => {
    resetMock();
    // First turn: invalid outcome
    mockCreate.mockImplementationOnce(() => ({
      content: [
        {
          type: "tool_use",
          name: "submit_outcome",
          id: "tu1",
          input: { outcome: "not_allowed" },
        },
      ],
    }));
    // Second turn: valid outcome
    mockCreate.mockImplementationOnce(() => ({
      content: [
        {
          type: "tool_use",
          name: "submit_outcome",
          id: "tu2",
          input: { outcome: "success" },
        },
      ],
    }));

    const host = new TestHost({ config: adapterConfig });
    await host.openSession({
      config: { model: "claude-sonnet-4-6" },
      secrets: { ANTHROPIC_API_KEY: "sk-test" },
    });

    const result = await host.execute({
      stepName: "analyze",
      input: { prompt: "Test prompt" },
      allowedOutcomes: ["success", "failure"],
    });

    expect(result.outcome).toBe("success");
    expect(mockCreate).toHaveBeenCalledTimes(2);
    await host.stop();
  });

  it("falls back to failure when max turns reached", async () => {
    resetMock();
    mockCreate.mockImplementation(() => ({
      content: [{ type: "text", text: "thinking..." }],
    }));

    const host = new TestHost({ config: adapterConfig });
    await host.openSession({
      config: { model: "claude-sonnet-4-6", max_turns: 2 },
      secrets: { ANTHROPIC_API_KEY: "sk-test" },
    });

    const result = await host.execute({
      stepName: "analyze",
      input: { prompt: "Test prompt" },
      allowedOutcomes: ["success", "failure"],
    });

    expect(result.outcome).toBe("failure");
    await host.stop();
  });

  it("serializes and restores session state with conversation history", async () => {
    resetMock();
    // First execute: success
    mockCreate.mockImplementationOnce(() => ({
      content: [
        {
          type: "tool_use",
          name: "submit_outcome",
          id: "tu1",
          input: { outcome: "success" },
        },
      ],
    }));

    const host = new TestHost({ config: adapterConfig });
    await host.openSession({
      config: { model: "claude-sonnet-4-6" },
      secrets: { ANTHROPIC_API_KEY: "sk-test" },
    });

    await host.execute({
      stepName: "s1",
      input: { prompt: "hello" },
      allowedOutcomes: ["success"],
    });

    const snapshot = await host.snapshot();
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.state.length).toBeGreaterThan(0);

    // Second host: restore and execute
    resetMock();
    mockCreate.mockImplementationOnce((params: any) => {
      // Verify history was restored
      expect(params.messages.length).toBeGreaterThanOrEqual(2);
      return {
        content: [
          {
            type: "tool_use",
            name: "submit_outcome",
            id: "tu2",
            input: { outcome: "success" },
          },
        ],
      };
    });

    const host2 = new TestHost({ config: adapterConfig });
    await host2.openSession({
      config: {},
      secrets: { ANTHROPIC_API_KEY: "sk-test" },
    });
    await host2.restore(snapshot);

    const result = await host2.execute({
      stepName: "s2",
      input: { prompt: "continue" },
      allowedOutcomes: ["success"],
    });

    expect(result.outcome).toBe("success");
    await host.stop();
    await host2.stop();
  });

  it("recreates client in execute if session was not opened first", async () => {
    resetMock();
    mockCreate.mockImplementationOnce(() => ({
      content: [
        {
          type: "tool_use",
          name: "submit_outcome",
          id: "tu1",
          input: { outcome: "success" },
        },
      ],
    }));

    // Create a custom adapter config that skips openSession client creation
    const customConfig = {
      ...adapterConfig,
      async openSession(_req: any, helpers: any) {
        // only set non-client state
        helpers.session.set("model", "claude-sonnet-4-6");
        helpers.session.set("maxTurns", 10);
        helpers.session.set("maxTokens", 4096);
        helpers.session.set("systemPrompt", "test");
        helpers.session.set("messages", []);
        helpers.session.set("finalizeAttempts", 0);
      },
    };

    const host = new TestHost({ config: customConfig });
    await host.openSession({
      config: {},
      secrets: { ANTHROPIC_API_KEY: "sk-test" },
    });

    const result = await host.execute({
      stepName: "s1",
      input: { prompt: "hello" },
      allowedOutcomes: ["success"],
    });

    expect(result.outcome).toBe("success");
    await host.stop();
  });

  it("honors max_turns = 0 as 0 (not fallback)", async () => {
    resetMock();
    // With max_turns = 0, the while loop should not run at all,
    // so the adapter falls back immediately.
    mockCreate.mockImplementation(() => ({
      content: [{ type: "text", text: "nope" }],
    }));

    const host = new TestHost({ config: adapterConfig });
    await host.openSession({
      config: { model: "claude-sonnet-4-6", max_turns: 0 },
      secrets: { ANTHROPIC_API_KEY: "sk-test" },
    });

    const result = await host.execute({
      stepName: "s1",
      input: { prompt: "hello" },
      allowedOutcomes: ["success", "failure"],
    });

    // max_turns 0 means no turns, so fallback immediately
    expect(result.outcome).toBe("failure");
    expect(mockCreate).toHaveBeenCalledTimes(0);
    await host.stop();
  });
});

describe("claude adapter helpers", () => {
  it("uses helpers.permission.request", async () => {
    const host = new TestHost({
      config: {
        name: "perm-test",
        version: "1.0.0",
        description: "test",
        permissions: ["read_file"],
        async execute(_req: any, helpers: any) {
          const decision = await helpers.permission.request({
            tool: "read_file",
            args: { path: "/tmp/test.txt" },
          });
          if (decision.decision === "allow") {
            await helpers.outcomes.finalize("success");
          } else {
            await helpers.outcomes.finalize("failure", { reason: decision.reason });
          }
        },
      },
      autoGrantPermissions: true,
    });

    await host.openSession({ config: {}, secrets: {} });
    const result = await host.execute({
      stepName: "s1",
      input: {},
      allowedOutcomes: ["success", "failure"],
    });

    expect(result.outcome).toBe("success");
    await host.stop();
  });

  it("uses helpers.log.stdout and stderr", async () => {
    const host = new TestHost({
      config: {
        name: "log-test",
        version: "1.0.0",
        description: "test",
        async execute(_req: any, helpers: any) {
          await helpers.log.stdout("stdout line\n");
          await helpers.log.stderr("stderr line\n");
          await helpers.outcomes.finalize("success");
        },
      },
    });

    await host.openSession({ config: {}, secrets: {} });
    const result = await host.execute({
      stepName: "s1",
      input: {},
      allowedOutcomes: ["success"],
    });

    expect(result.outcome).toBe("success");
    await host.stop();
  });
});
