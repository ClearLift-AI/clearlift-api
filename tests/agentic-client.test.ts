/**
 * Unit tests for the provider-agnostic agentic client.
 *
 * Tests schema translation, response parsing, tool result construction,
 * and multi-turn conversation handling for both Gemini and Anthropic clients.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GeminiAgenticClient,
  AnthropicAgenticClient,
  AgenticToolDef,
  AgenticToolResult,
  createAgenticClient,
} from '../src/services/analysis/agentic-client';
import { getToolDefinitions } from '../src/services/analysis/recommendation-tools';
import { SIMULATE_CHANGE_TOOL } from '../src/services/analysis/simulation-executor';

// ─── Mock fetch globally ──────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Test fixtures ────────────────────────────────────────────────────────────

const SAMPLE_TOOLS: AgenticToolDef[] = [
  {
    name: 'set_budget',
    description: 'Recommend a budget change',
    input_schema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'The platform', enum: ['facebook', 'google'] },
        entity_id: { type: 'string', description: 'Entity ID' },
        amount_cents: { type: 'number', description: 'Amount in cents' },
      },
      required: ['platform', 'entity_id', 'amount_cents'],
    },
  },
  {
    name: 'query_ad_metrics',
    description: 'Query ad platform data',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['performance', 'creatives'], description: 'Scope' },
        metrics: { type: 'array', items: { type: 'string' }, description: 'Metrics to query' },
        days: { type: 'number', description: 'Days of data', minimum: 1, maximum: 90 },
      },
      required: ['scope'],
    },
  },
  {
    name: 'set_schedule',
    description: 'Recommend schedule changes',
    input_schema: {
      type: 'object',
      properties: {
        hours_to_add: { type: 'array', description: 'Hours to add' },
        hours_to_remove: { type: 'array', description: 'Hours to remove' },
        targeting_changes: { type: 'object', description: 'Targeting parameters' },
      },
      required: [],
    },
  },
];

function makeGeminiResponse(parts: any[], usage?: any) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts, role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: usage || { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
    }),
    text: async () => '',
  };
}

function makeAnthropicResponse(content: any[], usage?: any) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      content,
      usage: usage || { input_tokens: 100, output_tokens: 50 },
    }),
    text: async () => '',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GEMINI CLIENT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('GeminiAgenticClient', () => {
  let client: GeminiAgenticClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new GeminiAgenticClient('test-api-key', 'gemini-3-flash-preview');
  });

  // ── Schema Translation ──────────────────────────────────────────────────

  describe('schema translation', () => {
    it('should translate tool definitions to Gemini functionDeclarations format', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse([{ text: 'Done' }]));

      await client.call(
        [{ role: 'user', parts: [{ text: 'test' }] }],
        'system prompt',
        SAMPLE_TOOLS
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const declarations = requestBody.tools[0].functionDeclarations;

      expect(declarations).toHaveLength(3);

      // Verify set_budget translation
      const setBudget = declarations.find((d: any) => d.name === 'set_budget');
      expect(setBudget.description).toBe('Recommend a budget change');
      expect(setBudget.parameters.type).toBe('object');
      expect(setBudget.parameters.properties.platform.enum).toEqual(['facebook', 'google']);
      expect(setBudget.parameters.required).toEqual(['platform', 'entity_id', 'amount_cents']);

      // Verify array properties preserved
      const queryMetrics = declarations.find((d: any) => d.name === 'query_ad_metrics');
      expect(queryMetrics.parameters.properties.metrics.type).toBe('array');
      expect(queryMetrics.parameters.properties.metrics.items).toEqual({ type: 'string' });
      expect(queryMetrics.parameters.properties.days.minimum).toBe(1);
      expect(queryMetrics.parameters.properties.days.maximum).toBe(90);

      // Verify nested object properties preserved
      const setSchedule = declarations.find((d: any) => d.name === 'set_schedule');
      expect(setSchedule.parameters.properties.targeting_changes.type).toBe('object');
      expect(setSchedule.parameters.properties.hours_to_add.type).toBe('array');
    });

    it('should translate all 8 recommendation tools correctly', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse([{ text: 'Done' }]));

      const allTools = getToolDefinitions() as AgenticToolDef[];
      await client.call(
        [{ role: 'user', parts: [{ text: 'test' }] }],
        'system prompt',
        allTools
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const declarations = requestBody.tools[0].functionDeclarations;

      expect(declarations).toHaveLength(allTools.length);

      const toolNames = declarations.map((d: any) => d.name);
      expect(toolNames).toContain('set_budget');
      expect(toolNames).toContain('set_status');
      expect(toolNames).toContain('reallocate_budget');
      expect(toolNames).toContain('set_audience');
      expect(toolNames).toContain('set_bid');
      expect(toolNames).toContain('set_schedule');
      expect(toolNames).toContain('general_insight');
      expect(toolNames).toContain('terminate_analysis');
    });

    it('should translate simulate_change tool correctly', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse([{ text: 'Done' }]));

      const simTool: AgenticToolDef = {
        name: SIMULATE_CHANGE_TOOL.name,
        description: SIMULATE_CHANGE_TOOL.description,
        input_schema: SIMULATE_CHANGE_TOOL.input_schema as any,
      };
      await client.call(
        [{ role: 'user', parts: [{ text: 'test' }] }],
        'system prompt',
        [simTool]
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const decl = requestBody.tools[0].functionDeclarations[0];

      expect(decl.name).toBe('simulate_change');
      expect(decl.parameters.properties.action.enum).toContain('pause');
      expect(decl.parameters.properties.action.enum).toContain('increase_budget');
      expect(decl.parameters.properties.hours_to_add.type).toBe('array');
    });

    it('should set system instruction correctly', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse([{ text: 'Done' }]));

      await client.call(
        [{ role: 'user', parts: [{ text: 'test' }] }],
        'You are an ad optimization AI.',
        SAMPLE_TOOLS
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.systemInstruction.parts[0].text).toBe('You are an ad optimization AI.');
    });
  });

  // ── Response Parsing ────────────────────────────────────────────────────

  describe('response parsing', () => {
    it('should parse a single functionCall response', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse([
        {
          functionCall: {
            name: 'set_budget',
            args: { platform: 'facebook', entity_id: 'camp_123', amount_cents: 5000 },
          },
        },
      ]));

      const result = await client.call(
        [{ role: 'user', parts: [{ text: 'analyze' }] }],
        'system',
        SAMPLE_TOOLS
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('set_budget');
      expect(result.toolCalls[0].input).toEqual({ platform: 'facebook', entity_id: 'camp_123', amount_cents: 5000 });
      expect(result.toolCalls[0].id).toMatch(/^gemini_tc_/);
      expect(result.textBlocks).toHaveLength(0);
    });

    it('should parse multiple functionCalls in one response', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse([
        { functionCall: { name: 'query_ad_metrics', args: { scope: 'performance' } } },
        { functionCall: { name: 'set_budget', args: { platform: 'google', entity_id: 'c1', amount_cents: 100 } } },
      ]));

      const result = await client.call(
        [{ role: 'user', parts: [{ text: 'analyze' }] }],
        'system',
        SAMPLE_TOOLS
      );

      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].name).toBe('query_ad_metrics');
      expect(result.toolCalls[1].name).toBe('set_budget');
      // IDs should be unique
      expect(result.toolCalls[0].id).not.toBe(result.toolCalls[1].id);
    });

    it('should parse text-only response with empty toolCalls', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse([
        { text: 'Analysis complete. No further recommendations needed.' },
      ]));

      const result = await client.call(
        [{ role: 'user', parts: [{ text: 'summarize' }] }],
        'system',
        SAMPLE_TOOLS
      );

      expect(result.toolCalls).toHaveLength(0);
      expect(result.textBlocks).toEqual(['Analysis complete. No further recommendations needed.']);
    });

    it('should parse mixed text + functionCall response', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse([
        { text: 'I found an issue with campaign performance.' },
        { functionCall: { name: 'set_status', args: { entity_id: 'c1', recommended_status: 'PAUSED' } } },
      ]));

      const result = await client.call(
        [{ role: 'user', parts: [{ text: 'analyze' }] }],
        'system',
        SAMPLE_TOOLS
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.textBlocks).toHaveLength(1);
      expect(result.textBlocks[0]).toContain('campaign performance');
    });

    it('should preserve rawAssistantMessage with all parts for conversation history', async () => {
      const responseParts = [
        { text: 'Thinking...' },
        { functionCall: { name: 'set_budget', args: { platform: 'google' } } },
        { thoughtSignature: 'abc123' },  // Simulated thought signature
      ];
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(responseParts));

      const result = await client.call(
        [{ role: 'user', parts: [{ text: 'analyze' }] }],
        'system',
        SAMPLE_TOOLS
      );

      // rawAssistantMessage should contain ALL parts verbatim
      expect(result.rawAssistantMessage.role).toBe('model');
      expect(result.rawAssistantMessage.parts).toHaveLength(3);
      expect(result.rawAssistantMessage.parts[2]).toEqual({ thoughtSignature: 'abc123' });
    });

    it('should track token usage from response', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(
        [{ text: 'done' }],
        { promptTokenCount: 500, candidatesTokenCount: 200, totalTokenCount: 700 }
      ));

      const result = await client.call(
        [{ role: 'user', parts: [{ text: 'test' }] }],
        'system',
        SAMPLE_TOOLS
      );

      expect(result.inputTokens).toBe(500);
      expect(result.outputTokens).toBe(200);
    });

    it('should handle empty candidates gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, totalTokenCount: 10 },
        }),
        text: async () => '',
      });

      const result = await client.call(
        [{ role: 'user', parts: [{ text: 'test' }] }],
        'system',
        SAMPLE_TOOLS
      );

      expect(result.toolCalls).toHaveLength(0);
      expect(result.textBlocks).toHaveLength(0);
    });
  });

  // ── Message Construction ────────────────────────────────────────────────

  describe('message construction', () => {
    it('should build user message in Gemini format', () => {
      const msg = client.buildUserMessage('Hello world');
      expect(msg).toEqual({ role: 'user', parts: [{ text: 'Hello world' }] });
    });

    it('should build assistant message preserving raw content', () => {
      const raw = { role: 'model', parts: [{ text: 'hi' }, { functionCall: { name: 'test', args: {} } }] };
      const msg = client.buildAssistantMessage(raw);
      // Gemini: raw content IS the message (already has role: 'model')
      expect(msg).toBe(raw);
    });

    it('should build tool results as functionResponse parts', () => {
      const results: AgenticToolResult[] = [
        { toolCallId: 'tc_1', name: 'set_budget', content: { status: 'logged', message: 'Budget set' } },
        { toolCallId: 'tc_2', name: 'query_ad_metrics', content: { success: true, data: { spend: 500 } } },
      ];

      const msg = client.buildToolResultsMessage(results);

      expect(msg.role).toBe('user');
      expect(msg.parts).toHaveLength(2);
      expect(msg.parts[0]).toEqual({
        functionResponse: {
          name: 'set_budget',
          response: { status: 'logged', message: 'Budget set' },
        },
      });
      expect(msg.parts[1]).toEqual({
        functionResponse: {
          name: 'query_ad_metrics',
          response: { success: true, data: { spend: 500 } },
        },
      });
    });
  });

  // ── Multi-turn Conversation ─────────────────────────────────────────────

  describe('multi-turn conversation', () => {
    it('should use role model (not assistant) in conversation history', async () => {
      // First call: model returns a function call
      mockFetch.mockResolvedValueOnce(makeGeminiResponse([
        { functionCall: { name: 'query_ad_metrics', args: { scope: 'performance' } } },
      ]));

      const result1 = await client.call(
        [{ role: 'user', parts: [{ text: 'analyze my ads' }] }],
        'system prompt',
        SAMPLE_TOOLS
      );

      // Build the conversation for the second call
      const assistantMsg = client.buildAssistantMessage(result1.rawAssistantMessage);
      const toolResultsMsg = client.buildToolResultsMessage([{
        toolCallId: result1.toolCalls[0].id,
        name: 'query_ad_metrics',
        content: { success: true, data: { spend: 1000 } },
      }]);

      // Verify role is 'model' not 'assistant'
      expect(assistantMsg.role).toBe('model');

      // Second call
      mockFetch.mockResolvedValueOnce(makeGeminiResponse([
        { text: 'Based on the metrics, everything looks good.' },
      ]));

      const messages = [
        { role: 'user', parts: [{ text: 'analyze my ads' }] },
        assistantMsg,
        toolResultsMsg,
      ];

      await client.call(messages, 'system prompt', SAMPLE_TOOLS);

      // Verify the second request has the full conversation
      const requestBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(requestBody.contents).toHaveLength(3);
      expect(requestBody.contents[0].role).toBe('user');
      expect(requestBody.contents[1].role).toBe('model');
      expect(requestBody.contents[2].role).toBe('user');
      expect(requestBody.contents[2].parts[0].functionResponse).toBeDefined();
    });
  });

  // ── Retry Behavior ──────────────────────────────────────────────────────

  describe('retry behavior', () => {
    it('should retry on 429 rate limit', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 429, headers: new Map(), text: async () => 'rate limited' })
        .mockResolvedValueOnce(makeGeminiResponse([{ text: 'ok' }]));

      const result = await client.call(
        [{ role: 'user', parts: [{ text: 'test' }] }],
        'system',
        SAMPLE_TOOLS
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.textBlocks).toEqual(['ok']);
    });

    it('should retry on 503 service unavailable', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 503, headers: new Map(), text: async () => 'unavailable' })
        .mockResolvedValueOnce(makeGeminiResponse([{ text: 'ok' }]));

      const result = await client.call(
        [{ role: 'user', parts: [{ text: 'test' }] }],
        'system',
        SAMPLE_TOOLS
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.textBlocks).toEqual(['ok']);
    });

    it('should throw after max retries', { timeout: 15000 }, async () => {
      mockFetch
        .mockResolvedValue({ ok: false, status: 429, headers: new Map(), text: async () => 'rate limited' });

      await expect(
        client.call([{ role: 'user', parts: [{ text: 'test' }] }], 'system', SAMPLE_TOOLS)
      ).rejects.toThrow();

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ANTHROPIC CLIENT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('AnthropicAgenticClient', () => {
  let client: AnthropicAgenticClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new AnthropicAgenticClient('test-api-key', 'claude-opus-4-5-20251101');
  });

  it('should build user message in Anthropic format', () => {
    const msg = client.buildUserMessage('Hello');
    expect(msg).toEqual({ role: 'user', content: 'Hello' });
  });

  it('should build assistant message wrapping content array', () => {
    const content = [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'tu1', name: 'test', input: {} }];
    const msg = client.buildAssistantMessage(content);
    expect(msg).toEqual({ role: 'assistant', content });
  });

  it('should build tool results with tool_use_id and JSON.stringify content', () => {
    const results: AgenticToolResult[] = [
      { toolCallId: 'tu_abc', name: 'set_budget', content: { status: 'logged' } },
    ];

    const msg = client.buildToolResultsMessage(results);
    expect(msg.role).toBe('user');
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0].type).toBe('tool_result');
    expect(msg.content[0].tool_use_id).toBe('tu_abc');
    expect(msg.content[0].content).toBe(JSON.stringify({ status: 'logged' }));
  });

  it('should parse tool_use blocks from Anthropic response', async () => {
    mockFetch.mockResolvedValueOnce(makeAnthropicResponse([
      { type: 'text', text: 'I recommend adjusting the budget.' },
      { type: 'tool_use', id: 'toolu_abc123', name: 'set_budget', input: { platform: 'facebook', entity_id: 'c1', amount_cents: 5000 } },
    ]));

    const result = await client.call(
      [{ role: 'user', content: 'analyze' }],
      'system',
      SAMPLE_TOOLS
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBe('toolu_abc123');
    expect(result.toolCalls[0].name).toBe('set_budget');
    expect(result.toolCalls[0].input.platform).toBe('facebook');
    expect(result.textBlocks).toEqual(['I recommend adjusting the budget.']);
  });

  it('should send tools in Anthropic input_schema format', async () => {
    mockFetch.mockResolvedValueOnce(makeAnthropicResponse([{ type: 'text', text: 'ok' }]));

    await client.call(
      [{ role: 'user', content: 'test' }],
      'system',
      SAMPLE_TOOLS
    );

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.tools[0].input_schema).toBeDefined();
    expect(requestBody.tools[0].input_schema.type).toBe('object');
    expect(requestBody.system).toBe('system');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FACTORY TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('createAgenticClient', () => {
  it('should create GeminiAgenticClient for gemini provider', () => {
    const client = createAgenticClient('gemini', 'key');
    expect(client).toBeInstanceOf(GeminiAgenticClient);
  });

  it('should create AnthropicAgenticClient for claude provider', () => {
    const client = createAgenticClient('claude', 'key');
    expect(client).toBeInstanceOf(AnthropicAgenticClient);
  });

  it('should throw for unknown provider', () => {
    expect(() => createAgenticClient('openai' as any, 'key')).toThrow('Unknown agentic provider');
  });
});
