/**
 * Email Service
 *
 * Handles sending transactional emails via SendGrid
 */

import { getSecret } from './secrets';

export interface EmailTemplate {
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  text?: string;
}

export interface SendGridResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

export class EmailService {
  private apiKey: string | null = null;
  private readonly fromEmail = 'noreply@clearlift.ai';
  private readonly fromName = 'ClearLift';
  private readonly baseUrl = 'https://app.clearlift.ai';

  constructor(private env: any) {}

  /**
   * Initialize the email service with SendGrid API key
   */
  private async init(): Promise<void> {
    if (!this.apiKey) {
      this.apiKey = await getSecret(this.env.SENDGRID_API_KEY) ?? null;
    }
  }

  /**
   * Send an email via SendGrid
   */
  private async sendEmail(template: EmailTemplate): Promise<SendGridResponse> {
    await this.init();

    if (!this.apiKey) {
      console.error('SendGrid API key not found');
      return { success: false, error: 'Email service not configured' };
    }

    try {
      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [(() => {
            const toList = Array.isArray(template.to)
              ? template.to.map(e => ({ email: e }))
              : [{ email: template.to }];
            const p: Record<string, any> = { to: toList };
            if (template.cc?.length) {
              p.cc = template.cc.map(e => ({ email: e }));
            }
            if (template.bcc?.length) {
              p.bcc = template.bcc.map(e => ({ email: e }));
            }
            return p;
          })()],
          from: {
            email: this.fromEmail,
            name: this.fromName
          },
          subject: template.subject,
          content: [
            {
              type: 'text/plain',
              value: template.text || this.htmlToText(template.html)
            },
            {
              type: 'text/html',
              value: template.html
            }
          ]
        })
      });

      if (response.ok) {
        const messageId = response.headers.get('X-Message-Id');
        return { success: true, messageId: messageId || undefined };
      } else {
        const error = await response.text();
        console.error('SendGrid error:', error);
        return { success: false, error: `SendGrid error: ${response.status}` };
      }
    } catch (error: any) {
      console.error('Email send error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send email verification email
   */
  async sendVerificationEmail(
    email: string,
    name: string,
    verificationToken: string
  ): Promise<SendGridResponse> {
    const verificationUrl = `${this.baseUrl}/verify-email?token=${verificationToken}`;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0; }
          .content { background: white; padding: 30px; border: 1px solid #e2e8f0; border-radius: 0 0 10px 10px; }
          .button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
          .footer { text-align: center; margin-top: 30px; color: #718096; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">Welcome to ClearLift!</h1>
          </div>
          <div class="content">
            <p>Hi ${name},</p>
            <p>Thanks for signing up for ClearLift! Please verify your email address to complete your registration and access all features.</p>
            <center>
              <a href="${verificationUrl}" class="button">Verify Email Address</a>
            </center>
            <p>Or copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #667eea;">${verificationUrl}</p>
            <p>This link will expire in 24 hours. If you didn't create a ClearLift account, you can safely ignore this email.</p>
          </div>
          <div class="footer">
            <p>© ${new Date().getFullYear()} ClearLift. All rights reserved.</p>
            <p>Questions? Contact us at support@clearlift.ai</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail({
      to: email,
      subject: 'Verify your ClearLift email address',
      html
    });
  }

  /**
   * Send password reset email
   */
  async sendPasswordResetEmail(
    email: string,
    name: string,
    resetToken: string
  ): Promise<SendGridResponse> {
    const resetUrl = `${this.baseUrl}/reset-password?token=${resetToken}`;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0; }
          .content { background: white; padding: 30px; border: 1px solid #e2e8f0; border-radius: 0 0 10px 10px; }
          .button { display: inline-block; background: #f5576c; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
          .footer { text-align: center; margin-top: 30px; color: #718096; font-size: 14px; }
          .warning { background: #fef5e7; border-left: 4px solid #f39c12; padding: 10px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">Password Reset Request</h1>
          </div>
          <div class="content">
            <p>Hi ${name},</p>
            <p>We received a request to reset your ClearLift account password. Click the button below to create a new password:</p>
            <center>
              <a href="${resetUrl}" class="button">Reset Password</a>
            </center>
            <p>Or copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #f5576c;">${resetUrl}</p>
            <div class="warning">
              <strong>Security Notice:</strong> This link will expire in 1 hour. If you didn't request a password reset, please ignore this email or contact support if you have concerns about your account security.
            </div>
            <p>For security reasons, all your active sessions will be logged out after resetting your password.</p>
          </div>
          <div class="footer">
            <p>© ${new Date().getFullYear()} ClearLift. All rights reserved.</p>
            <p>Questions? Contact us at support@clearlift.ai</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail({
      to: email,
      subject: 'Reset your ClearLift password',
      html
    });
  }

  /**
   * Send password reset confirmation email
   */
  async sendPasswordResetConfirmation(
    email: string,
    name: string
  ): Promise<SendGridResponse> {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0; }
          .content { background: white; padding: 30px; border: 1px solid #e2e8f0; border-radius: 0 0 10px 10px; }
          .success { color: #48bb78; font-size: 18px; font-weight: bold; }
          .footer { text-align: center; margin-top: 30px; color: #718096; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">Password Reset Successful</h1>
          </div>
          <div class="content">
            <p>Hi ${name},</p>
            <p class="success">✓ Your password has been successfully reset!</p>
            <p>You can now log in to your ClearLift account with your new password.</p>
            <p>For your security, all previous sessions have been logged out. You'll need to log in again on any devices where you were previously signed in.</p>
            <p>If you didn't make this change, please contact our support team immediately at support@clearlift.ai</p>
          </div>
          <div class="footer">
            <p>© ${new Date().getFullYear()} ClearLift. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail({
      to: email,
      subject: 'Your ClearLift password has been reset',
      html
    });
  }

  /**
   * Send organization invitation email
   */
  async sendOrganizationInvite(
    email: string,
    organizationName: string,
    inviterName: string,
    role: string,
    inviteCode: string
  ): Promise<SendGridResponse> {
    const joinUrl = `${this.baseUrl}/join?code=${inviteCode}`;

    const roleDescription = {
      owner: 'full control including billing and organization settings',
      admin: 'manage connections, team members, and settings',
      viewer: 'view analytics and reports'
    }[role] || 'access the organization';

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0; }
          .content { background: white; padding: 30px; border: 1px solid #e2e8f0; border-radius: 0 0 10px 10px; }
          .button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
          .invite-box { background: #f7fafc; border: 1px solid #e2e8f0; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .footer { text-align: center; margin-top: 30px; color: #718096; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">You're Invited to ClearLift!</h1>
          </div>
          <div class="content">
            <p>Hi there,</p>
            <p><strong>${inviterName}</strong> has invited you to join <strong>${organizationName}</strong> on ClearLift.</p>

            <div class="invite-box">
              <p><strong>Organization:</strong> ${organizationName}</p>
              <p><strong>Your Role:</strong> ${role.charAt(0).toUpperCase() + role.slice(1)}</p>
              <p><strong>Permissions:</strong> You'll be able to ${roleDescription}</p>
            </div>

            <p>ClearLift helps teams track and analyze their marketing data across multiple advertising platforms in one unified dashboard.</p>

            <center>
              <a href="${joinUrl}" class="button">Accept Invitation</a>
            </center>

            <p>Or use this invitation code: <strong>${inviteCode}</strong></p>
            <p style="color: #718096; font-size: 14px;">This invitation will expire in 7 days.</p>

            <p>If you don't have a ClearLift account yet, you'll be prompted to create one when accepting this invitation.</p>
          </div>
          <div class="footer">
            <p>© ${new Date().getFullYear()} ClearLift. All rights reserved.</p>
            <p>Questions? Contact us at support@clearlift.ai</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail({
      to: email,
      subject: `${inviterName} invited you to join ${organizationName} on ClearLift`,
      html
    });
  }

  /**
   * Send waitlist welcome email
   */
  async sendWaitlistWelcome(
    email: string,
    name?: string
  ): Promise<SendGridResponse> {
    const greeting = name ? `Hi ${name}` : 'Hi there';

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #0ea5e9 0%, #2563eb 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0; }
          .content { background: white; padding: 30px; border: 1px solid #e2e8f0; border-radius: 0 0 10px 10px; }
          .highlight { background: #f0f9ff; border-left: 4px solid #0ea5e9; padding: 15px; margin: 20px 0; }
          .footer { text-align: center; margin-top: 30px; color: #718096; font-size: 14px; }
          .emoji { font-size: 24px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">Welcome to ClearLift! <span class="emoji">🚀</span></h1>
          </div>
          <div class="content">
            <p>${greeting},</p>
            <p><strong>Thank you for joining the ClearLift waitlist!</strong> You're now part of an exclusive group who will be the first to experience the future of AI-powered ad performance tracking.</p>

            <div class="highlight">
              <p style="margin: 0;"><strong>What's Next?</strong></p>
              <ul style="margin: 10px 0; padding-left: 20px;">
                <li>We'll notify you as soon as we launch</li>
                <li>You'll get exclusive early access to the platform</li>
                <li>Expect updates on our progress and industry insights</li>
              </ul>
            </div>

            <p><strong>Why ClearLift?</strong></p>
            <ul>
              <li><strong>Unified CAC Tracking:</strong> See the true cost of customer acquisition across all your ad platforms</li>
              <li><strong>LUNA™ Attribution:</strong> Our AI-powered attribution engine reveals what's really driving conversions</li>
              <li><strong>Free Forever:</strong> Core dashboard features are completely free, no credit card required</li>
            </ul>

            <p>Get ready to transform your advertising with analytics that actually work.</p>

            <p style="margin-top: 30px;">Best regards,<br>
            <strong>The ClearLift Team</strong></p>
          </div>
          <div class="footer">
            <p>© ${new Date().getFullYear()} ClearLift. All rights reserved.</p>
            <p>Questions? Contact us at support@clearlift.ai</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail({
      to: email,
      subject: 'Welcome to the ClearLift Waitlist! 🚀',
      html
    });
  }

  /**
   * Send admin welcome invite email (static template)
   */
  async sendAdminWelcomeInvite(
    to: string | string[],
    cc?: string[],
    bcc?: string[]
  ): Promise<SendGridResponse> {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to ClearLift</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #f5f5f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
    }

    .email-container {
      max-width: 600px;
      width: 100%;
      background: #fff;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
    }

    .header {
      padding: 32px 40px;
      border-bottom: 1px solid #eee;
    }

    .logo {
      display: inline-flex;
      align-items: center;
      gap: 10px;
    }

    .logo-icon {
      width: 24px;
      height: 24px;
    }

    .logo-text {
      font-size: 20px;
      font-weight: 700;
      color: #111;
      letter-spacing: -0.3px;
    }

    .content {
      padding: 48px 40px;
    }

    .headline {
      font-size: 32px;
      font-weight: 800;
      color: #111;
      text-align: center;
      line-height: 1.2;
      margin-bottom: 16px;
      letter-spacing: -0.5px;
    }

    .subheadline {
      font-size: 16px;
      line-height: 1.6;
      color: #555;
      text-align: center;
      margin-bottom: 8px;
    }

    .cta-section {
      text-align: center;
      margin-bottom: 32px;
    }

    .cta-button-primary {
      display: inline-block;
      background: #1e3a5f;
      color: #fff;
      text-decoration: none;
      padding: 14px 28px;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      margin-right: 8px;
      margin-bottom: 8px;
    }

    .footer {
      text-align: center;
      padding: 24px 40px;
      background: #fafafa;
      border-top: 1px solid #eee;
    }

    .footer-text {
      font-size: 12px;
      color: #999;
    }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="header">
      <div class="logo">
        <svg class="logo-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M16 4L28 28H4L16 4Z" stroke="#111" stroke-width="2.5" fill="none"/>
        </svg>
        <span class="logo-text">ClearLift</span>
      </div>
    </div>

    <div class="content">
      <h1 class="headline">Welcome to ClearLift!</h1>

      <p class="subheadline">
        You've been invited to join ClearLift. Your dashboard is ready — just complete your registration to start seeing your ad performance across all your channels in one place.
      </p>

      <div class="cta-section">
        <a href="https://app.clearlift.ai/register?utm_source=email&utm_medium=welcome&utm_campaign=onboarding" class="cta-button-primary">
          Complete Registration
        </a>
      </div>
    </div>

    <div class="footer">
      <p class="footer-text">&copy; 2025 ClearLift</p>
    </div>
  </div>
</body>
</html>`;

    return this.sendEmail({
      to,
      cc,
      bcc,
      subject: 'Welcome to ClearLift',
      html
    });
  }

  /**
   * Convert HTML to plain text (basic implementation)
   */
  private htmlToText(html: string): string {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

/**
 * Create a singleton instance of the email service
 */
export const createEmailService = (env: any): EmailService => {
  return new EmailService(env);
};