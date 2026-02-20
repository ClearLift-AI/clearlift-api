/**
 * Tests for Attentive webhook signature verification and event parsing
 *
 * verifyWebhookSignature is the sole gatekeeper between the public internet
 * and our sync queue. A bypass here means attackers can inject fake SMS events,
 * corrupt the journey graph, and manipulate attribution data. A false rejection
 * means legitimate Attentive events get silently dropped.
 *
 * parseWebhookEvent transforms raw Attentive payloads into our internal format.
 * A wrong mapping here means events get stored with wrong subscriber IDs,
 * missing email addresses (broken identity stitching), or wrong timestamps
 * (corrupted journey timeline).
 */

import { describe, it, expect } from 'vitest';
import { AttentiveAPIProvider, type AttentiveRawWebhookPayload } from '../src/services/providers/attentive';

// =============================================================================
// verifyWebhookSignature
// =============================================================================

describe('AttentiveAPIProvider.verifyWebhookSignature', () => {
  const TEST_SECRET = 'whsec_test_secret_key_123';

  /**
   * Helper: compute a valid HMAC-SHA256 signature for a given body+secret.
   * This mirrors what Attentive's servers would produce.
   */
  async function computeSignature(body: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    return Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  it('accepts a valid signature', async () => {
    const body = '{"type":"sms.sent","timestamp":1700000000000}';
    const signature = await computeSignature(body, TEST_SECRET);

    const result = await AttentiveAPIProvider.verifyWebhookSignature(body, signature, TEST_SECRET);
    expect(result).toBe(true);
  });

  it('rejects an invalid signature', async () => {
    const body = '{"type":"sms.sent","timestamp":1700000000000}';
    const wrongSignature = 'deadbeef'.repeat(8); // 64 hex chars, wrong content

    const result = await AttentiveAPIProvider.verifyWebhookSignature(body, wrongSignature, TEST_SECRET);
    expect(result).toBe(false);
  });

  it('rejects when body has been tampered with', async () => {
    const originalBody = '{"type":"sms.sent","timestamp":1700000000000}';
    const signature = await computeSignature(originalBody, TEST_SECRET);
    const tamperedBody = '{"type":"sms.sent","timestamp":9999999999999}';

    const result = await AttentiveAPIProvider.verifyWebhookSignature(tamperedBody, signature, TEST_SECRET);
    expect(result).toBe(false);
  });

  it('rejects when secret is wrong', async () => {
    const body = '{"type":"sms.sent"}';
    const signature = await computeSignature(body, TEST_SECRET);

    const result = await AttentiveAPIProvider.verifyWebhookSignature(body, signature, 'wrong_secret');
    expect(result).toBe(false);
  });

  it('rejects empty signature', async () => {
    const result = await AttentiveAPIProvider.verifyWebhookSignature('body', '', TEST_SECRET);
    expect(result).toBe(false);
  });

  it('rejects empty secret', async () => {
    const result = await AttentiveAPIProvider.verifyWebhookSignature('body', 'sig', '');
    expect(result).toBe(false);
  });

  it('handles large payloads without truncation', async () => {
    // Attentive can batch events — body could be large
    const bigBody = JSON.stringify({
      type: 'sms.sent',
      data: 'x'.repeat(100_000),
    });
    const signature = await computeSignature(bigBody, TEST_SECRET);

    const result = await AttentiveAPIProvider.verifyWebhookSignature(bigBody, signature, TEST_SECRET);
    expect(result).toBe(true);
  });

  it('is case-sensitive for signatures (hex lowercase)', async () => {
    const body = '{"type":"sms.sent"}';
    const signature = await computeSignature(body, TEST_SECRET);
    const uppercased = signature.toUpperCase();

    // Our implementation expects lowercase hex
    const result = await AttentiveAPIProvider.verifyWebhookSignature(body, uppercased, TEST_SECRET);
    expect(result).toBe(false);
  });

  it('rejects signature with different length (timing-safe)', async () => {
    const body = '{"type":"sms.sent"}';
    const shortSig = 'abcd'; // Way too short

    const result = await AttentiveAPIProvider.verifyWebhookSignature(body, shortSig, TEST_SECRET);
    expect(result).toBe(false);
  });
});

// =============================================================================
// parseWebhookEvent
// =============================================================================

describe('AttentiveAPIProvider.parseWebhookEvent', () => {
  const makePayload = (overrides: Partial<AttentiveRawWebhookPayload> = {}): AttentiveRawWebhookPayload => ({
    type: 'sms.sent',
    timestamp: 1700000000000, // 2023-11-14T22:13:20Z
    company: {
      display_name: 'Acme Corp',
      company_id: 'comp_123',
    },
    subscriber: {
      email: 'user@example.com',
      phone: '+15551234567',
      external_id: 'sub_456',
    },
    message: {
      id: 'msg_789',
      type: 'campaign',
      name: 'Black Friday Sale',
      text: 'Check out our deals!',
      channel: 'sms',
    },
    ...overrides,
  });

  it('extracts event_type from payload.type', () => {
    const result = AttentiveAPIProvider.parseWebhookEvent(makePayload({ type: 'sms.message_link_click' }));
    expect(result.event_type).toBe('sms.message_link_click');
  });

  it('extracts message_id from message.id', () => {
    const result = AttentiveAPIProvider.parseWebhookEvent(makePayload());
    expect(result.message_id).toBe('msg_789');
  });

  it('generates fallback message_id when message.id is missing', () => {
    const result = AttentiveAPIProvider.parseWebhookEvent(makePayload({
      message: undefined,
    }));
    expect(result.message_id).toBe('sms.sent-1700000000000');
  });

  it('extracts subscriber_id from external_id', () => {
    const result = AttentiveAPIProvider.parseWebhookEvent(makePayload());
    expect(result.subscriber_id).toBe('sub_456');
  });

  it('falls back to phone for subscriber_id when external_id missing', () => {
    const result = AttentiveAPIProvider.parseWebhookEvent(makePayload({
      subscriber: { phone: '+15551234567' },
    }));
    expect(result.subscriber_id).toBe('+15551234567');
  });

  it('falls back to "unknown" when no subscriber identifiers exist', () => {
    const result = AttentiveAPIProvider.parseWebhookEvent(makePayload({
      subscriber: {} as any,
    }));
    expect(result.subscriber_id).toBe('unknown');
  });

  it('extracts subscriber_email when present', () => {
    const result = AttentiveAPIProvider.parseWebhookEvent(makePayload());
    expect(result.subscriber_email).toBe('user@example.com');
  });

  it('returns undefined subscriber_email when not present', () => {
    const result = AttentiveAPIProvider.parseWebhookEvent(makePayload({
      subscriber: { phone: '+15551234567' },
    }));
    expect(result.subscriber_email).toBeUndefined();
  });

  it('extracts company_id', () => {
    const result = AttentiveAPIProvider.parseWebhookEvent(makePayload());
    expect(result.company_id).toBe('comp_123');
  });

  it('converts Unix milliseconds to ISO 8601 timestamp', () => {
    const result = AttentiveAPIProvider.parseWebhookEvent(makePayload({ timestamp: 1700000000000 }));
    expect(result.timestamp).toBe('2023-11-14T22:13:20.000Z');
  });

  it('extracts link_url for click events', () => {
    const result = AttentiveAPIProvider.parseWebhookEvent(makePayload({
      type: 'sms.message_link_click',
      link: { url: 'https://shop.example.com/deals' },
    }));
    expect(result.link_url).toBe('https://shop.example.com/deals');
  });

  it('returns undefined link_url when link not present', () => {
    const result = AttentiveAPIProvider.parseWebhookEvent(makePayload());
    expect(result.link_url).toBeUndefined();
  });

  it('extracts campaign metadata from message and creative fields', () => {
    const result = AttentiveAPIProvider.parseWebhookEvent(makePayload({
      creative: { name: 'Holiday Creative', type: 'banner' },
    }));
    expect(result.campaign_id).toBe('msg_789');
    expect(result.campaign_name).toBe('Black Friday Sale'); // From message.name
    expect(result.metadata.creative_type).toBe('banner');
  });

  it('falls back campaign_name to creative.name when message.name missing', () => {
    const result = AttentiveAPIProvider.parseWebhookEvent(makePayload({
      message: { id: 'msg_1' },
      creative: { name: 'Solo Creative' },
    }));
    expect(result.campaign_name).toBe('Solo Creative');
  });

  it('includes subscription type in metadata', () => {
    const result = AttentiveAPIProvider.parseWebhookEvent(makePayload({
      subscription: { type: 'MARKETING' },
    }));
    expect(result.metadata.subscription_type).toBe('MARKETING');
  });

  it('handles minimal payload (only required fields)', () => {
    const minimal: AttentiveRawWebhookPayload = {
      type: 'sms.subscribed',
      timestamp: 1700000000000,
      company: { display_name: 'Test', company_id: 'c_1' },
      subscriber: {},
    } as any;

    const result = AttentiveAPIProvider.parseWebhookEvent(minimal);
    expect(result.event_type).toBe('sms.subscribed');
    expect(result.company_id).toBe('c_1');
    expect(result.subscriber_id).toBe('unknown');
    expect(result.message_id).toContain('sms.subscribed');
  });
});
