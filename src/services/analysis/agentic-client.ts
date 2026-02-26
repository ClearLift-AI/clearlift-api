/**
 * Provider-Agnostic Agentic Client
 *
 * Abstracts the LLM provider (Gemini / Anthropic) for the agentic tool-calling loop.
 * Both implementations translate to/from a canonical tool format that matches
 * the existing Anthropic shape (name + description + input_schema).
 */

import { structuredLog } from '../../utils/structured-logger';
import { GEMINI_MODELS, CLAUDE_MODELS } from './llm-provider';

// ═══════════════════════════════════════════════════════════════════════════
// CANONICAL TYPES (provider-agnostic)
// ═══════════════════════════════════════════════════════════════════════════

/** Tool definition in canonical format (matches existing Anthropic shape) */
export interface AgenticToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

/** Extracted tool call from model response */
export interface AgenticToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
}

/** Result from a single LLM call */
export interface AgenticCallResult {
  toolCalls: AgenticToolCall[];
  textBlocks: string[];
  rawAssistantMessage: any;
  inputTokens: number;
  outputTokens: number;
}

/** Tool result to send back */
export interface AgenticToolResult {
  toolCallId: string;
  name: string;
  content: Record<string, any>;
}

/** Options for controlling LLM call behavior */
export interface AgenticCallOptions {
  /** Thinking level for Gemini 3 models: 'minimal' | 'low' | 'medium' | 'high' */
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
}

/** Provider-agnostic agentic client */
export interface AgenticClient {
  /** Build the initial user message in the correct provider format */
  buildUserMessage(text: string): any;

  /** Make an LLM call with tools */
  call(
    messages: any[],
    systemPrompt: string,
    tools: AgenticToolDef[],
    maxTokens?: number,
    options?: AgenticCallOptions
  ): Promise<AgenticCallResult>;

  /** Build the assistant message to append to conversation history */
  buildAssistantMessage(rawAssistantMessage: any): any;

  /** Build the tool results message to append to conversation history */
  buildToolResultsMessage(results: AgenticToolResult[]): any;
}

// ═══════════════════════════════════════════════════════════════════════════
// GEMINI IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

interface GeminiAgenticResponse {
  candidates: Array<{
    content: {
      parts: Array<any>;
      role: string;
    };
    finishReason: string;
  }>;
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  modelVersion?: string;
}

export class GeminiAgenticClient implements AgenticClient {
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  private readonly maxRetries = 3;
  private readonly baseRetryDelayMs = 500;
  private readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model || GEMINI_MODELS.FLASH;
  }

  buildUserMessage(text: string): any {
    return { role: 'user', parts: [{ text }] };
  }

  async call(
    messages: any[],
    systemPrompt: string,
    tools: AgenticToolDef[],
    maxTokens: number = 2048,
    options?: AgenticCallOptions
  ): Promise<AgenticCallResult> {
    const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;

    const generationConfig: Record<string, any> = {
      maxOutputTokens: maxTokens,
      temperature: 0.3
    };

    // Add thinkingConfig for Gemini 3 models (supports: minimal, low, medium, high)
    if (options?.thinkingLevel) {
      generationConfig.thinkingConfig = {
        thinkingLevel: options.thinkingLevel.toUpperCase()
      };
    }

    const request = {
      contents: messages,
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      tools: [{
        functionDeclarations: tools.map(t => this.translateToolDef(t))
      }],
      generationConfig
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request)
        });

        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '0');
          const backoffMs = Math.max(retryAfter * 1000, this.baseRetryDelayMs * Math.pow(2, attempt));
          const jitter = Math.random() * 1000;
          structuredLog('WARN', 'Gemini agentic 429, retrying', {
            service: 'agentic-client',
            delay_s: Math.round((backoffMs + jitter) / 1000),
            attempt: attempt + 1
          });
          await this.sleep(backoffMs + jitter);
          lastError = new Error(`Rate limited (429) after ${attempt + 1} attempts`);
          continue;
        }

        if (response.status === 503) {
          const backoffMs = this.baseRetryDelayMs * Math.pow(2, attempt);
          const jitter = Math.random() * 1000;
          structuredLog('WARN', 'Gemini agentic 503, retrying', {
            service: 'agentic-client',
            delay_s: Math.round((backoffMs + jitter) / 1000),
            attempt: attempt + 1
          });
          await this.sleep(backoffMs + jitter);
          lastError = new Error(`Service unavailable (503) after ${attempt + 1} attempts`);
          continue;
        }

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Gemini agentic API error: ${response.status} - ${errorBody}`);
        }

        const data: GeminiAgenticResponse = await response.json();
        return this.parseResponse(data);

      } catch (error) {
        lastError = error as Error;
        if (attempt < this.maxRetries - 1) {
          const backoffMs = this.baseRetryDelayMs * Math.pow(2, attempt);
          const jitter = Math.random() * 1000;
          structuredLog('WARN', 'Gemini agentic network error, retrying', {
            service: 'agentic-client',
            delay_s: Math.round((backoffMs + jitter) / 1000),
            attempt: attempt + 1,
            error: lastError.message
          });
          await this.sleep(backoffMs + jitter);
          continue;
        }
      }
    }

    throw lastError || new Error('Gemini agentic call failed after max retries');
  }

  buildAssistantMessage(rawAssistantMessage: any): any {
    // rawAssistantMessage is the full candidate.content object from Gemini
    // role is 'model', parts include functionCall and/or text and/or thoughtSignature
    return rawAssistantMessage;
  }

  buildToolResultsMessage(results: AgenticToolResult[]): any {
    return {
      role: 'user',
      parts: results.map(r => ({
        functionResponse: {
          name: r.name,
          response: r.content
        }
      }))
    };
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private translateToolDef(tool: AgenticToolDef): GeminiFunctionDeclaration {
    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: tool.input_schema.type,
        properties: tool.input_schema.properties,
        ...(tool.input_schema.required ? { required: tool.input_schema.required } : {})
      }
    };
  }

  private parseResponse(data: GeminiAgenticResponse): AgenticCallResult {
    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts) {
      return {
        toolCalls: [],
        textBlocks: [],
        rawAssistantMessage: { role: 'model', parts: [] },
        inputTokens: data.usageMetadata?.promptTokenCount || 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount || 0
      };
    }

    const parts = candidate.content.parts;
    const toolCalls: AgenticToolCall[] = [];
    const textBlocks: string[] = [];

    let callIndex = 0;
    for (const part of parts) {
      if (part.functionCall) {
        toolCalls.push({
          // Gemini doesn't provide tool call IDs, so we generate synthetic ones
          id: `gemini_tc_${Date.now()}_${callIndex++}`,
          name: part.functionCall.name,
          input: part.functionCall.args || {}
        });
      } else if (part.text) {
        textBlocks.push(part.text);
      }
      // Preserve all other parts (thoughtSignature, etc.) in rawAssistantMessage
    }

    return {
      toolCalls,
      textBlocks,
      // Preserve the entire content object verbatim for conversation history
      // This ensures thoughtSignature and other metadata survive across turns
      rawAssistantMessage: candidate.content,
      inputTokens: data.usageMetadata?.promptTokenCount || 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount || 0
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ANTHROPIC IMPLEMENTATION (fallback)
// ═══════════════════════════════════════════════════════════════════════════

export class AnthropicAgenticClient implements AgenticClient {
  private readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model || CLAUDE_MODELS.OPUS;
  }

  buildUserMessage(text: string): any {
    return { role: 'user', content: text };
  }

  async call(
    messages: any[],
    systemPrompt: string,
    tools: AgenticToolDef[],
    maxTokens: number = 2048,
    _options?: AgenticCallOptions
  ): Promise<AgenticCallResult> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages,
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema
        }))
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const result = await response.json() as any;

    const toolCalls: AgenticToolCall[] = [];
    const textBlocks: string[] = [];

    for (const block of (result.content || [])) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input
        });
      } else if (block.type === 'text') {
        textBlocks.push(block.text);
      }
    }

    return {
      toolCalls,
      textBlocks,
      rawAssistantMessage: result.content,
      inputTokens: result.usage?.input_tokens || 0,
      outputTokens: result.usage?.output_tokens || 0
    };
  }

  buildAssistantMessage(rawAssistantMessage: any): any {
    // Anthropic: assistant message content is the raw content array
    return { role: 'assistant', content: rawAssistantMessage };
  }

  buildToolResultsMessage(results: AgenticToolResult[]): any {
    return {
      role: 'user',
      content: results.map(r => ({
        type: 'tool_result',
        tool_use_id: r.toolCallId,
        content: JSON.stringify(r.content)
      }))
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════

export type AgenticProvider = 'gemini' | 'claude';

export function createAgenticClient(
  provider: AgenticProvider,
  apiKey: string,
  model?: string
): AgenticClient {
  switch (provider) {
    case 'gemini':
      return new GeminiAgenticClient(apiKey, model);
    case 'claude':
      return new AnthropicAgenticClient(apiKey, model);
    default:
      throw new Error(`Unknown agentic provider: ${provider}`);
  }
}
