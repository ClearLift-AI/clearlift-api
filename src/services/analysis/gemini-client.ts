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
  private readonly baseRetryDelayMs = 500;  // Reduced to avoid waitUntil timeout

  // Request tracking for audit
  private requestCount = 0;
  private requestsThisMinute = 0;
  private minuteStartTime = Date.now();

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

    // Track requests per minute
    const now = Date.now();
    if (now - this.minuteStartTime > 60000) {
      this.requestsThisMinute = 0;
      this.minuteStartTime = now;
    }
    this.requestCount++;
    this.requestsThisMinute++;

    console.log(`[Gemini AUDIT] Request #${this.requestCount} (${this.requestsThisMinute} this minute) to ${model}`);

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
          // Rate limited - log full error for debugging
          const errorBody = await response.text();
          console.log(`[Gemini AUDIT] 429 Rate Limited! Request #${this.requestCount}, ${this.requestsThisMinute} RPM`);
          console.log(`[Gemini AUDIT] Error body: ${errorBody}`);
          console.log(`[Gemini AUDIT] Headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);

          // Exponential backoff with jitter
          const retryAfter = parseInt(response.headers.get('retry-after') || '0');
          const backoffMs = Math.max(retryAfter * 1000, this.baseRetryDelayMs * Math.pow(2, attempt));
          const jitter = Math.random() * 1000;
          console.log(`[Gemini] Rate limited, retrying in ${Math.round((backoffMs + jitter) / 1000)}s (attempt ${attempt + 1}/${this.maxRetries})`);
          await this.sleep(backoffMs + jitter);
          lastError = new Error(`Rate limited (429) after ${attempt + 1} attempts`);
          continue;
        }

        if (response.status === 503) {
          // Service unavailable - exponential backoff with jitter
          const backoffMs = this.baseRetryDelayMs * Math.pow(2, attempt);
          const jitter = Math.random() * 1000;
          console.log(`[Gemini] Service unavailable, retrying in ${Math.round((backoffMs + jitter) / 1000)}s (attempt ${attempt + 1}/${this.maxRetries})`);
          await this.sleep(backoffMs + jitter);
          lastError = new Error(`Service unavailable (503) after ${attempt + 1} attempts`);
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

        console.log(`[Gemini AUDIT] Request #${this.requestCount} SUCCESS in ${latencyMs}ms (${data.usageMetadata?.promptTokenCount || 0} in / ${data.usageMetadata?.candidatesTokenCount || 0} out tokens)`);

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

        // Retry on network errors with exponential backoff
        if (attempt < this.maxRetries - 1) {
          const backoffMs = this.baseRetryDelayMs * Math.pow(2, attempt);
          const jitter = Math.random() * 1000;
          console.log(`[Gemini] Network error, retrying in ${Math.round((backoffMs + jitter) / 1000)}s (attempt ${attempt + 1}/${this.maxRetries}): ${lastError.message}`);
          await this.sleep(backoffMs + jitter);
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
