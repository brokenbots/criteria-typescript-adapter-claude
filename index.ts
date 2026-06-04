/**
 * Anthropic Claude Adapter for Criteria (Protocol v2)
 *
 * This adapter enables using Anthropic's Claude models as agent backends in Criteria
 * workflows. It supports multi-turn conversations, tool calling, and
 * outcome finalization via the v2 SDK helper surface.
 *
 * Secrets (all flow via the secret channel; only ANTHROPIC_API_KEY is required):
 * - ANTHROPIC_API_KEY    – Required. Your Anthropic API key.
 * - ANTHROPIC_BASE_URL   – Optional. Override the API base URL.
 *
 * Example workflow:
 * ```hcl
 * step "analyze" {
 *   adapter = "claude"
 *   input {
 *     prompt    = "Analyze this codebase for security issues"
 *     max_turns = 10
 *   }
 *   outcome "clean"        { transition_to = "deploy" }
 *   outcome "issues_found" { transition_to = "review" }
 *   outcome "failure"      { transition_to = "failed" }
 * }
 * ```
 */

import { serve } from "@criteria/adapter-sdk";
import Anthropic from "@anthropic-ai/sdk";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_TOKENS = 4096;

const SUBMIT_OUTCOME_TOOL_NAME = "submit_outcome";
const SUBMIT_OUTCOME_DESCRIPTION = `Finalize the outcome for the current step. Call this exactly once with one of the allowed outcomes before ending the turn. The allowed outcomes are provided in the conversation context. Failure to call this tool with a valid outcome will fail the step.`;

// ============================================================================
// Helpers
// ============================================================================

function buildSystemPrompt(configSystemPrompt?: string): string {
  return (
    configSystemPrompt ??
    "You are a helpful assistant integrated into a workflow system. When you complete your task, you MUST call the submit_outcome tool with the appropriate outcome to proceed."
  );
}

function buildTools(): Anthropic.Tool[] {
  return [
    {
      name: SUBMIT_OUTCOME_TOOL_NAME,
      description: SUBMIT_OUTCOME_DESCRIPTION,
      input_schema: {
        type: "object",
        properties: {
          outcome: {
            type: "string",
            description: "The outcome name to finalize. Must be one of the allowed outcomes.",
          },
          reason: {
            type: "string",
            description: "Optional reason for the outcome.",
          },
        },
        required: ["outcome"],
      },
    },
  ];
}

interface SubmitOutcomeArgs {
  outcome: string;
  reason?: string;
}

function parseSubmitOutcomeArgs(raw: unknown): SubmitOutcomeArgs {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("submit_outcome arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  if (typeof args.outcome !== "string") {
    throw new Error('submit_outcome argument "outcome" is required and must be a string');
  }
  return {
    outcome: args.outcome,
    reason: typeof args.reason === "string" ? args.reason : undefined,
  };
}

// ============================================================================
// Main
// ============================================================================

serve({
  name: "claude",
  version: "2.0.0",
  description: "Anthropic Claude adapter for Criteria workflows.",
  source_url: "https://github.com/criteria-adapters/claude",
  capabilities: ["multi_turn", "structured_events", "tool_calling"],
  platforms: ["linux/amd64", "linux/arm64", "darwin/arm64"],

  config_schema: {
    fields: {
      model: {
        type: "string",
        required: false,
        description: `Model to use (default: ${DEFAULT_MODEL})`,
      },
      max_turns: {
        type: "number",
        required: false,
        description: "Maximum turns per Execute call",
      },
      max_tokens: {
        type: "number",
        required: false,
        description: `Maximum tokens per response (default: ${DEFAULT_MAX_TOKENS})`,
      },
      system_prompt: {
        type: "string",
        required: false,
        description: "System prompt for the conversation",
      },
    },
  },

  input_schema: {
    fields: {
      prompt: {
        type: "string",
        required: true,
        description: "The prompt to send to Claude",
      },
      max_turns: {
        type: "number",
        required: false,
        description: "Per-step override for max turns",
      },
      max_tokens: {
        type: "number",
        required: false,
        description: "Per-step override for max tokens",
      },
      model: {
        type: "string",
        required: false,
        description: "Per-step override for model",
      },
    },
  },

  output_schema: {
    fields: {
      reason: {
        type: "string",
        required: false,
        description: "Reason for the chosen outcome",
      },
    },
  },

  secrets: [
    {
      name: "ANTHROPIC_API_KEY",
      required: true,
      description: "Anthropic API key",
    },
    {
      name: "ANTHROPIC_BASE_URL",
      required: false,
      description: "Override the Anthropic API base URL",
    },
  ],

  permissions: ["read_file", "write_file"],

  async openSession(req, helpers) {
    const apiKey = await helpers.secrets.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("Anthropic API key is required. Set the ANTHROPIC_API_KEY secret.");
    }

    const baseURL = (await helpers.secrets.get("ANTHROPIC_BASE_URL")) ?? undefined;

    const client = new Anthropic({
      apiKey,
      baseURL,
    });

    const model = req.config.model || DEFAULT_MODEL;
    const maxTurns = parseInt(req.config.max_turns, 10) || DEFAULT_MAX_TURNS;
    const maxTokens = parseInt(req.config.max_tokens, 10) || DEFAULT_MAX_TOKENS;
    const systemPrompt = buildSystemPrompt(req.config.system_prompt);

    helpers.session.set("client", client);
    helpers.session.set("model", model);
    helpers.session.set("maxTurns", maxTurns);
    helpers.session.set("maxTokens", maxTokens);
    helpers.session.set("systemPrompt", systemPrompt);
    helpers.session.set("messages", [] as Anthropic.MessageParam[]);
    helpers.session.set("finalizeAttempts", 0);

    await helpers.log.stdout(`[claude] Session opened (model=${model})\n`);
  },

  async execute(req, helpers) {
    const prompt = req.input.prompt;
    if (!prompt) {
      throw new Error("input.prompt is required");
    }

    const client = helpers.session.get<Anthropic>("client");
    const model = req.input.model ?? helpers.session.get<string>("model") ?? DEFAULT_MODEL;
    const maxTurns =
      parseInt(req.input.max_turns, 10) ||
      helpers.session.get<number>("maxTurns") ||
      DEFAULT_MAX_TURNS;
    const maxTokens =
      parseInt(req.input.max_tokens, 10) ||
      helpers.session.get<number>("maxTokens") ||
      DEFAULT_MAX_TOKENS;
    const systemPrompt = helpers.session.get<string>("systemPrompt") ?? buildSystemPrompt();

    // Reset per-execution state
    helpers.session.set("finalizeAttempts", 0);
    let messages = helpers.session.get<Anthropic.MessageParam[]>("messages") ?? [];

    // Add allowed-outcomes preamble to the prompt
    const allowedOutcomes = req.allowed_outcomes ?? [];
    if (allowedOutcomes.length > 0) {
      const outcomeList = allowedOutcomes.join(", ");
      const preamble = `You must finalize the outcome for this step by calling the submit_outcome tool exactly once before ending the turn. The allowed outcomes are: ${outcomeList}. If you do not call the tool with a valid outcome, the step will fail.\n\n`;
      messages.push({ role: "user", content: preamble + prompt });
    } else {
      messages.push({ role: "user", content: prompt });
    }

    await helpers.log.stdout(`[claude] Starting conversation with model ${model}\n`);

    const tools = buildTools();
    let turnCount = 0;

    while (turnCount < maxTurns) {
      turnCount++;
      await helpers.log.stdout(`[claude] Turn ${turnCount}/${maxTurns}\n`);

      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages,
        tools,
      });

      const message = response;

      // Append assistant message to history
      messages.push({ role: "assistant", content: message.content });

      // Stream content blocks
      const textBlocks = message.content.filter((block) => block.type === "text");
      for (const block of textBlocks) {
        if (block.text) {
          await helpers.log.stdout(block.text);
          await helpers.log.adapterEvent("agent.message", {
            content: block.text,
            turn: turnCount,
          });
        }
      }

      // Handle tool use
      const toolUseBlocks = message.content.filter((block) => block.type === "tool_use");
      let finalized = false;

      for (const toolUse of toolUseBlocks) {
        if (toolUse.name === SUBMIT_OUTCOME_TOOL_NAME) {
          const currentAttempts = helpers.session.get<number>("finalizeAttempts") ?? 0;
          helpers.session.set("finalizeAttempts", currentAttempts + 1);

          let args: SubmitOutcomeArgs;
          try {
            args = parseSubmitOutcomeArgs(toolUse.input);
          } catch (e) {
            await helpers.log.adapterEvent("tool.error", {
              error: "Failed to parse submit_outcome arguments",
              detail: String(e),
            });
            messages.push({
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUse.id,
                  content: `Error: Failed to parse submit_outcome arguments. ${String(e)}`,
                } as any,
              ],
            });
            continue;
          }

          const outcome = args.outcome?.trim();
          const reason = args.reason?.trim() ?? "";

          // Validate outcome via helpers.outcomes
          const validation = await helpers.outcomes.validate(outcome);
          if (!validation.valid) {
            const errorMsg = validation.error ?? `Outcome "${outcome}" is not allowed.`;
            await helpers.log.adapterEvent("outcome.finalized", {
              outcome,
              reason,
              success: false,
              error: errorMsg,
            });
            messages.push({
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUse.id,
                  content: errorMsg,
                } as any,
              ],
            });
            continue;
          }

          // Success — finalize
          await helpers.log.adapterEvent("outcome.finalized", {
            outcome,
            reason,
            success: true,
          });

          await helpers.outcomes.finalize(outcome, { reason });
          helpers.session.set("messages", messages);
          finalized = true;
          break;
        }
      }

      if (finalized) {
        return;
      }

      // If no tool calls, the model ended the turn without finalizing
      if (toolUseBlocks.length === 0) {
        break;
      }
    }

    // Max turns reached or conversation ended without outcome
    if (turnCount >= maxTurns) {
      await helpers.log.adapterEvent("limit.reached", { max_turns: maxTurns });
    } else {
      await helpers.log.adapterEvent("outcome.failure", {
        reason: "missing finalize",
        attempts: helpers.session.get<number>("finalizeAttempts") ?? 0,
      });
    }

    // Fallback outcome selection
    const fallback = allowedOutcomes.includes("needs_review")
      ? "needs_review"
      : "failure";
    await helpers.outcomes.finalize(fallback, {
      reason:
        turnCount >= maxTurns
          ? "Max turns reached"
          : "Conversation ended without submit_outcome",
    });

    helpers.session.set("messages", messages);
  },

  async snapshot(sessionId, helpers) {
    const messages = helpers.session.get<Anthropic.MessageParam[]>("messages") ?? [];
    const state = {
      messages,
      model: helpers.session.get<string>("model"),
      maxTurns: helpers.session.get<number>("maxTurns"),
      maxTokens: helpers.session.get<number>("maxTokens"),
      systemPrompt: helpers.session.get<string>("systemPrompt"),
      finalizeAttempts: helpers.session.get<number>("finalizeAttempts"),
    };
    return {
      state: new TextEncoder().encode(JSON.stringify(state)),
      schema_version: 1,
    };
  },

  async restore(sessionId, blob, helpers) {
    const state = JSON.parse(new TextDecoder().decode(blob.state)) as {
      messages: Anthropic.MessageParam[];
      model: string;
      maxTurns: number;
      maxTokens: number;
      systemPrompt: string;
      finalizeAttempts: number;
    };

    helpers.session.set("messages", state.messages);
    helpers.session.set("model", state.model);
    helpers.session.set("maxTurns", state.maxTurns);
    helpers.session.set("maxTokens", state.maxTokens);
    helpers.session.set("systemPrompt", state.systemPrompt);
    helpers.session.set("finalizeAttempts", state.finalizeAttempts);
  },

  async closeSession(req, helpers) {
    await helpers.log.stdout(`[claude] Session closed\n`);
  },
});
