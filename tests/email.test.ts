/**
 * Unit tests for EmailService
 *
 * Covers:
 * - EMAIL_DRY_RUN guard: sendEmail returns early without external calls
 * - APP_BASE_URL env-awareness: custom base URL flows through to email templates
 * - Default base URL fallback
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmailService } from '../src/utils/email';

describe('EmailService — EMAIL_DRY_RUN guard', () => {
  it('should return { success: true, messageId: "dry-run" } without calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const service = new EmailService({
      EMAIL_DRY_RUN: 'true',
      SENDGRID_API_KEY: 'SG.should-not-be-used',
    });

    const result = await service.sendVerificationEmail(
      'user@example.com',
      'Test User',
      'token-abc'
    );

    expect(result).toEqual({ success: true, messageId: 'dry-run' });
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('should return dry-run for all public email methods', async () => {
    const service = new EmailService({
      EMAIL_DRY_RUN: 'true',
    });

    const verification = await service.sendVerificationEmail('a@b.com', 'A', 'tok');
    const reset = await service.sendPasswordResetEmail('a@b.com', 'A', 'tok');
    const confirm = await service.sendPasswordResetConfirmation('a@b.com', 'A');
    const invite = await service.sendOrganizationInvite('a@b.com', 'Org', 'Inviter', 'admin', 'code');
    const waitlist = await service.sendWaitlistWelcome('a@b.com', 'A');
    const admin = await service.sendAdminWelcomeInvite('a@b.com');

    for (const result of [verification, reset, confirm, invite, waitlist, admin]) {
      expect(result).toEqual({ success: true, messageId: 'dry-run' });
    }
  });

  it('should NOT dry-run when EMAIL_DRY_RUN is absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 202, headers: { 'X-Message-Id': 'sg-123' } })
    );

    const service = new EmailService({
      SENDGRID_API_KEY: 'SG.test-key',
    });

    const result = await service.sendVerificationEmail('a@b.com', 'A', 'tok');

    // Should actually call fetch (SendGrid), not return dry-run
    expect(result.messageId).not.toBe('dry-run');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  });

  it('should NOT dry-run when EMAIL_DRY_RUN is "false"', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 202, headers: { 'X-Message-Id': 'sg-456' } })
    );

    const service = new EmailService({
      EMAIL_DRY_RUN: 'false',
      SENDGRID_API_KEY: 'SG.test-key',
    });

    const result = await service.sendVerificationEmail('a@b.com', 'A', 'tok');

    expect(result.messageId).not.toBe('dry-run');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  });
});

describe('EmailService — env-aware baseUrl', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 202, headers: { 'X-Message-Id': 'sg-msg-id' } })
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('should use APP_BASE_URL when provided', async () => {
    const customUrl = 'https://staging.clearlift.ai';

    const service = new EmailService({
      APP_BASE_URL: customUrl,
      SENDGRID_API_KEY: 'SG.test-key',
    });

    await service.sendVerificationEmail('user@example.com', 'Test', 'tok-123');

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');

    const body = JSON.parse((init as RequestInit).body as string);
    const htmlContent = body.content.find((c: any) => c.type === 'text/html')?.value;

    expect(htmlContent).toContain(`${customUrl}/verify-email?token=tok-123`);
    expect(htmlContent).not.toContain('https://app.clearlift.ai');
  });

  it('should default to https://app.clearlift.ai when APP_BASE_URL is not set', async () => {
    const service = new EmailService({
      SENDGRID_API_KEY: 'SG.test-key',
    });

    await service.sendVerificationEmail('user@example.com', 'Test', 'tok-456');

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    const htmlContent = body.content.find((c: any) => c.type === 'text/html')?.value;

    expect(htmlContent).toContain('https://app.clearlift.ai/verify-email?token=tok-456');
  });

  it('should use custom baseUrl in password reset emails', async () => {
    const customUrl = 'https://dev.clearlift.ai';

    const service = new EmailService({
      APP_BASE_URL: customUrl,
      SENDGRID_API_KEY: 'SG.test-key',
    });

    await service.sendPasswordResetEmail('user@example.com', 'Test', 'reset-tok');

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    const htmlContent = body.content.find((c: any) => c.type === 'text/html')?.value;

    expect(htmlContent).toContain(`${customUrl}/reset-password?token=reset-tok`);
  });

  it('should use custom baseUrl in organization invite emails', async () => {
    const customUrl = 'https://dev.clearlift.ai';

    const service = new EmailService({
      APP_BASE_URL: customUrl,
      SENDGRID_API_KEY: 'SG.test-key',
    });

    await service.sendOrganizationInvite('user@example.com', 'Acme', 'Jane', 'admin', 'inv-code');

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    const htmlContent = body.content.find((c: any) => c.type === 'text/html')?.value;

    expect(htmlContent).toContain(`${customUrl}/join?code=inv-code`);
  });

  it('should use custom baseUrl in admin welcome invite emails', async () => {
    const customUrl = 'https://dev.clearlift.ai';

    const service = new EmailService({
      APP_BASE_URL: customUrl,
      SENDGRID_API_KEY: 'SG.test-key',
    });

    await service.sendAdminWelcomeInvite('user@example.com');

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    const htmlContent = body.content.find((c: any) => c.type === 'text/html')?.value;

    expect(htmlContent).toContain(`${customUrl}/register?utm_source=email`);
  });
});
