import Anthropic from "@anthropic-ai/sdk";
import type { AgentEnvironment } from "./guard.js";
import {
  AnthropicResearchModel,
  DEFAULT_MODEL,
  type ResearchModel,
} from "./model.js";
import { OpenAICompatibleModel } from "./openai-model.js";

/**
 * The model the environment names (D8): Claude by default, or OpenAI /
 * DeepSeek through the OpenAI-compatible adapter with the model the operator
 * named. The key is read from the provider's own variable, nowhere else.
 */
export function modelFor(
  agent: AgentEnvironment,
  env: Readonly<Record<string, string | undefined>>,
  effort: "medium" | "high" | "xhigh",
): ResearchModel {
  const key = env[agent.keyVariable] ?? "";
  if (agent.provider === "anthropic")
    return new AnthropicResearchModel(
      new Anthropic({ apiKey: key }),
      agent.model ?? DEFAULT_MODEL,
      effort,
    );
  if (agent.model === undefined)
    throw new Error(`${agent.provider} needs AGENT_MODEL`);
  return OpenAICompatibleModel.for(agent.provider, key, agent.model);
}
