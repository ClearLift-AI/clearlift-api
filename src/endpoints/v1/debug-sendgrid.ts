/**
 * Debug SendGrid - Test email sending
 */

import { Hono } from 'hono';
import { createEmailService } from '../../utils/email';
import { getSecret } from '../../utils/secrets';

const app = new Hono();

app.get('/v1/debug/sendgrid', async (c) => {
  try {
    // Check if secret exists
    const sendgridKey = await getSecret(c.env.SENDGRID_API_KEY);

    if (!sendgridKey) {
      return c.json({
        error: 'SENDGRID_API_KEY not found or empty',
        binding_exists: !!c.env.SENDGRID_API_KEY,
        binding_type: typeof c.env.SENDGRID_API_KEY
      }, 500);
    }

    // Test direct SendGrid call
    const testEmail = 'paul.r.santillan@gmail.com';
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sendgridKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{
          to: [{ email: testEmail }]
        }],
        from: {
          email: 'noreply@clearlift.ai',
          name: 'ClearLift Debug'
        },
        subject: 'SendGrid Test - Debug Endpoint',
        content: [{
          type: 'text/html',
          value: '<h1>Test Email</h1><p>If you see this, SendGrid is working!</p>'
        }]
      })
    });

    const responseText = await response.text();
    const messageId = response.headers.get('X-Message-Id');

    return c.json({
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      messageId,
      responseBody: responseText,
      keyLength: sendgridKey.length,
      keyPreview: `${sendgridKey.substring(0, 10)}...`
    });

  } catch (error: any) {
    return c.json({
      error: 'Exception',
      message: error.message,
      stack: error.stack
    }, 500);
  }
});

export default app;
