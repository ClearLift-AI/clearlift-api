/**
 * Google Gemini API Client
 *
 * Handles Gemini API calls for ad analysis summaries
 * Uses direct fetch to Generative Language API
 */

import {
  LLMClient,
  LLMResponse,
  GenerateOptions,
  GEMINI_MODELS
} from './llm-provider';

interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: {
    parts: Array<{ text: string }>;
  };
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
  };
}

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{ text: string }>;
      role: string;
    };
    finishReason: string;
    safetyRatings?: Array<{
      category: string;
      probability: string;
    }>;
  }>;
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  modelVersion: string;
}

export class GeminiClient implements LLMClient {
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  private readonly maxRetries = 3;
  private readonly retryDelayMs = 1000;

  constructor(private apiKey: string) {}

  async generateSummary(
    systemPrompt: string,
    userPrompt: string,
    options?: GenerateOptions
  ): Promise<LLMResponse> {
    const model = options?.model || GEMINI_MODELS.FLASH_LITE;
    const maxTokens = options?.maxTokens || 512;
    const temperature = options?.temperature ?? 0.3;

    const request: GeminiRequest = {
      contents: [
        {
          role: 'user',
          parts: [{ text: userPrompt }]
        }
      ],
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature
      }
    };

    const startTime = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const url = `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`;

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(request)
        });

        if (response.status === 429) {
          // Rate limited - wait and retry
          const retryAfter = parseInt(response.headers.get('retry-after') || '5');
          await this.sleep(retryAfter * 1000);
          continue;
        }

        if (response.status === 503) {
          // Service unavailable - wait and retry with exponential backoff
          await this.sleep(this.retryDelayMs * Math.pow(2, attempt));
          continue;
        }

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Gemini API error: ${response.status} - ${errorBody}`);
        }

        const data: GeminiResponse = await response.json();
        const latencyMs = Date.now() - startTime;

        // Extract text from response
        const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        return {
          content,
          inputTokens: data.usageMetadata?.promptTokenCount || 0,
          outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
          latencyMs,
          provider: 'gemini',
          model: data.modelVersion || model
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
