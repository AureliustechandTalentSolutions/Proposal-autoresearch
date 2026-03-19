/**
 * LLM Provider Abstraction
 *
 * Unified interface for calling language models. Supports Anthropic Claude
 * (cloud) and Ollama-hosted local models (Nemotron, Llama, Qwen).
 * Implements automatic fallback from cloud to local when configured.
 */

import { z } from "zod";

export type LLMProvider = "anthropic" | "ollama" | "auto";

export interface LLMCallOptions {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
  provider?: LLMProvider;
  model?: string;
}

export interface LLMCallResult {
  content: string;
  model: string;
  provider: LLMProvider;
  tokensUsed: number;
  latencyMs: number;
}

// Configuration from environment
const LLM_CONFIG = {
  provider: (process.env.LLM_PROVIDER ?? "auto") as LLMProvider,
  model: process.env.LLM_MODEL ?? "claude-sonnet-4-20250514",
  localModel: process.env.LOCAL_MODEL ?? "nemotron:latest",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  ollamaEndpoint: process.env.OLLAMA_ENDPOINT ?? "http://nemotron:11434",
};

/**
 * Call an LLM with automatic provider selection and fallback.
 */
export async function callLLM(options: LLMCallOptions): Promise<LLMCallResult> {
  const provider = options.provider ?? LLM_CONFIG.provider;
  const startTime = Date.now();

  if (provider === "auto") {
    return callWithFallback(options, startTime);
  }

  if (provider === "anthropic") {
    return callAnthropic(options, startTime);
  }

  return callOllama(options, startTime);
}

/**
 * Auto mode: try Anthropic first, fall back to local Ollama.
 */
async function callWithFallback(
  options: LLMCallOptions,
  startTime: number,
): Promise<LLMCallResult> {
  // Try Anthropic if API key is available
  if (LLM_CONFIG.anthropicApiKey) {
    try {
      return await callAnthropic(options, startTime);
    } catch (error) {
      console.warn("Anthropic call failed, falling back to local model:", error);
    }
  }

  // Fall back to Ollama
  return callOllama(options, startTime);
}

/**
 * Call Anthropic Claude API.
 */
async function callAnthropic(
  options: LLMCallOptions,
  startTime: number,
): Promise<LLMCallResult> {
  const model = options.model ?? LLM_CONFIG.model;

  // Separate system message from conversation messages
  const systemMessage = options.messages.find((m) => m.role === "system")?.content;
  const conversationMessages = options.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": LLM_CONFIG.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      system: systemMessage,
      messages: conversationMessages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
    model: string;
    usage: { input_tokens: number; output_tokens: number };
  };

  const content = data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  return {
    content,
    model: data.model,
    provider: "anthropic",
    tokensUsed: data.usage.input_tokens + data.usage.output_tokens,
    latencyMs: Date.now() - startTime,
  };
}

/**
 * Call Ollama-hosted local model.
 */
async function callOllama(
  options: LLMCallOptions,
  startTime: number,
): Promise<LLMCallResult> {
  const model = options.model ?? LLM_CONFIG.localModel;

  // Convert messages to Ollama chat format
  const messages = options.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const response = await fetch(`${LLM_CONFIG.ollamaEndpoint}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens ?? 4096,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    message: { role: string; content: string };
    model: string;
    eval_count?: number;
    prompt_eval_count?: number;
  };

  return {
    content: data.message.content,
    model: data.model,
    provider: "ollama",
    tokensUsed: (data.eval_count ?? 0) + (data.prompt_eval_count ?? 0),
    latencyMs: Date.now() - startTime,
  };
}

/**
 * Check if a specific provider is available.
 */
export async function checkProviderHealth(
  provider: LLMProvider,
): Promise<boolean> {
  try {
    if (provider === "anthropic" || provider === "auto") {
      if (!LLM_CONFIG.anthropicApiKey) return provider === "auto";
      // Lightweight check - just verify the key format
      return LLM_CONFIG.anthropicApiKey.startsWith("sk-ant-");
    }

    if (provider === "ollama") {
      const response = await fetch(`${LLM_CONFIG.ollamaEndpoint}/api/tags`);
      return response.ok;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * List available models for a given provider.
 */
export async function listModels(
  provider: LLMProvider,
): Promise<string[]> {
  if (provider === "ollama" || provider === "auto") {
    try {
      const response = await fetch(`${LLM_CONFIG.ollamaEndpoint}/api/tags`);
      if (!response.ok) return [];
      const data = (await response.json()) as { models: Array<{ name: string }> };
      return data.models.map((m) => m.name);
    } catch {
      return [];
    }
  }

  if (provider === "anthropic") {
    // Return known Anthropic models
    return [
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
      "claude-haiku-35-20241022",
    ];
  }

  return [];
}
