/**
 * Anthropic Claude API Client
 *
 * Handles Claude API calls for ad analysis summaries
 * Uses direct fetch to avoid SDK dependencies in Cloudflare Workers
 */

import {
  LLMClient,
  LLMResponse,
  GenerateOptions,
  CLAUDE_MODELS
} from './llm-provider';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  temperature?: number;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{
    type: 'text';
    text: string;
  }>;
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export class AnthropicClient implements LLMClient {
  private readonly baseUrl = 'https://api.anthropic.com/v1';
  private readonly apiVersion = '2023-06-01';
  private readonly maxRetries = 3;
  private readonly retryDelayMs = 1000;

  constructor(private apiKey: string) {}

  async generateSummary(
    systemPrompt: string,
    userPrompt: string,
    options?: GenerateOptions
  ): Promise<LLMResponse> {
    const model = options?.model || CLAUDE_MODELS.HAIKU;
    const maxTokens = options?.maxTokens || 512;
    const temperature = options?.temperature ?? 0.3;

    const request: AnthropicRequest = {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ],
      temperature
    };

    const startTime = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': this.apiVersion
          },
          body: JSON.stringify(request)
        });

        if (response.status === 429) {
          // Rate limited - wait and retry
          const retryAfter = parseInt(response.headers.get('retry-after') || '5');
          await this.sleep(retryAfter * 1000);
          continue;
        }

        if (response.status === 529) {
          // Overloaded - wait and retry with exponential backoff
          await this.sleep(this.retryDelayMs * Math.pow(2, attempt));
          continue;
        }

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Anthropic API error: ${response.status} - ${errorBody}`);
        }

        const data: AnthropicResponse = await response.json();
        const latencyMs = Date.now() - startTime;

        return {
          content: data.content[0]?.text || '',
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
          latencyMs,
          provider: 'claude',
          model: data.model
        };

      } catch (error) {
        lastError = error as Error;

        // Retry on network errors
        if (attempt < this.maxRetries - 1) {
          await this.sleep(this.retryDelayMs * Math.pow(2, attempt));
          continue;
        }
      }
    }

    throw lastError || new Error('Failed to generate summary after max retries');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
