import nodemailer from 'nodemailer';
import { logger } from '@/utils/core/logger';

export interface WorkspaceInviteEmailData {
  inviteId: string;
  workspaceId: string;
  workspaceName?: string;
  invitedByName?: string;
  recipientEmail: string;
  role: 'owner' | 'full_access' | 'view';
  frontendUrl: string;
}

export interface ApprovalEmailData {
  recipientEmail: string;
  recipientName?: string;
  frontendUrl: string;
}

export interface RejectionEmailData {
  recipientEmail: string;
  recipientName?: string;
  frontendUrl: string;
}

export interface GenericEmailData {
  recipientEmail: string;
  subject: string;
  textContent: string;
  htmlContent?: string;
}

/**
 * Email Service for sending custom emails
 * Uses the same SMTP settings as Supabase (Gmail)
 */
export class EmailService {
  /**
   * Create nodemailer transporter with Supabase SMTP settings
   */
  private static createTransporter() {
    // Use the same SMTP settings as configured in Supabase Dashboard
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // use TLS
      auth: {
        user: 'noreply@qait.dev',
        pass: process.env.SMTP_PASSWORD || '', // Need to add this to .env
      },
    });
  }

  /**
   * Send workspace invite email to existing users
   */
  static async sendWorkspaceInvite(data: WorkspaceInviteEmailData): Promise<{ success: boolean; error?: string }> {
    try {
      const inviteUrl = `${data.frontendUrl}/invite/accept?token=${data.inviteId}&workspaceId=${data.workspaceId}`;

      const roleText = data.role === 'full_access' ? 'Full Access' : 'View Only';
      const workspaceName = data.workspaceName || 'a workspace';
      const invitedByText = data.invitedByName ? `${data.invitedByName} has invited` : 'You have been invited';

      const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Workspace Invitation</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 28px;">QAIT.dev</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 16px;">Workspace Invitation</p>
  </div>

  <div style="background: #ffffff; padding: 40px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
    <h2 style="color: #333; margin-top: 0;">You're Invited!</h2>

    <p style="font-size: 16px; color: #555;">
      ${invitedByText} you to join <strong>${workspaceName}</strong> on QAIT.dev.
    </p>

    <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 25px 0;">
      <p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">Your Role:</p>
      <p style="margin: 0; font-size: 18px; font-weight: 600; color: #667eea;">${roleText}</p>
    </div>

    <div style="text-align: center; margin: 35px 0;">
      <a href="${inviteUrl}" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 14px 40px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
        Accept Invitation
      </a>
    </div>

    <p style="font-size: 14px; color: #888; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
      This invitation will expire in 7 days. If you didn't expect this invitation, you can safely ignore this email.
    </p>

    <p style="font-size: 12px; color: #aaa; margin-top: 20px;">
      If the button doesn't work, copy and paste this link into your browser:<br>
      <a href="${inviteUrl}" style="color: #667eea; word-break: break-all;">${inviteUrl}</a>
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p>© 2026 QAIT.dev - AI-Powered Testing Platform</p>
  </div>
</body>
</html>
      `.trim();

      const textContent = `
You're Invited to QAIT.dev!

${invitedByText} you to join ${workspaceName}.

Your Role: ${roleText}

Click the link below to accept your invitation:
${inviteUrl}

This invitation will expire in 7 days.

If you didn't expect this invitation, you can safely ignore this email.

---
© 2026 QAIT.dev - AI-Powered Testing Platform
      `.trim();

      logger.info('[EMAIL_SERVICE] Sending custom invite email', {
        recipientEmail: data.recipientEmail,
        inviteUrl,
        workspaceName,
      });

      // Check if SMTP password is configured
      if (!process.env.SMTP_PASSWORD) {
        logger.error('[EMAIL_SERVICE] SMTP_PASSWORD not configured in .env');
        return { success: false, error: 'SMTP not configured' };
      }

      const transporter = this.createTransporter();

      await transporter.sendMail({
        from: '"QAIT.dev" <noreply@qait.dev>',
        to: data.recipientEmail,
        subject: `You've been invited to join ${workspaceName} on QAIT.dev`,
        text: textContent,
        html: htmlContent,
      });

      logger.info('[EMAIL_SERVICE] Custom invite email sent successfully', {
        recipientEmail: data.recipientEmail,
        inviteId: data.inviteId,
      });

      return { success: true };
    } catch (error) {
      logger.error('[EMAIL_SERVICE] Failed to send workspace invite', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        recipientEmail: data.recipientEmail,
      });
      return { success: false, error: 'Failed to send email' };
    }
  }

  /**
   * Send approval notification email to a user whose account has been approved
   */
  static async sendApprovalEmail(data: ApprovalEmailData): Promise<{ success: boolean; error?: string }> {
    try {
      const loginUrl = data.frontendUrl;
      const name = data.recipientName || 'there';

      const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Account Approved</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 28px;">QAIT.dev</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 16px;">Account Approved</p>
  </div>

  <div style="background: #ffffff; padding: 40px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
    <h2 style="color: #333; margin-top: 0;">You're in! Welcome to QAIT.dev</h2>

    <p style="font-size: 16px; color: #555;">
      Hey ${name}! Great news — your account has been approved. You now have full access to the platform.
    </p>

    <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 25px 0;">
      <p style="margin: 0 0 12px 0; font-size: 15px; font-weight: 600; color: #333;">Here's what you can do:</p>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 6px 0; font-size: 14px; color: #555; vertical-align: top; width: 24px;">&#x1F680;</td>
          <td style="padding: 6px 0; font-size: 14px; color: #555;">Run AI-powered tests on your web apps</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-size: 14px; color: #555; vertical-align: top;">&#x1F4AC;</td>
          <td style="padding: 6px 0; font-size: 14px; color: #555;">Chat with our AI assistant to create test plans</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-size: 14px; color: #555; vertical-align: top;">&#x1F4CA;</td>
          <td style="padding: 6px 0; font-size: 14px; color: #555;">Track results and get detailed reports</td>
        </tr>
      </table>
    </div>

    <div style="text-align: center; margin: 35px 0;">
      <a href="${loginUrl}" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 14px 40px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
        Get Started
      </a>
    </div>

    <!-- Russian version -->
    <div style="margin-top: 30px; padding-top: 25px; border-top: 1px solid #e0e0e0;">
      <p style="font-size: 13px; color: #999; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 0.5px;">&#x1F1F7;&#x1F1FA; Russian version</p>
      <p style="font-size: 15px; color: #555;">
        ${name}, отличные новости — ваш аккаунт одобрен! Теперь у вас есть полный доступ к платформе QAIT.dev.
      </p>
      <p style="font-size: 14px; color: #555; margin-bottom: 4px;"><strong>Что вы можете делать:</strong></p>
      <ul style="font-size: 14px; color: #555; padding-left: 20px; margin: 8px 0;">
        <li style="margin-bottom: 4px;">Запускать AI-тесты для ваших веб-приложений</li>
        <li style="margin-bottom: 4px;">Создавать тест-планы в чате с AI-ассистентом</li>
        <li style="margin-bottom: 4px;">Отслеживать результаты и получать подробные отчёты</li>
      </ul>
    </div>

    <p style="font-size: 12px; color: #aaa; margin-top: 25px;">
      If the button doesn't work, copy and paste this link:<br>
      <a href="${loginUrl}" style="color: #667eea; word-break: break-all;">${loginUrl}</a>
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p>&copy; 2026 QAIT.dev - AI-Powered Testing Platform</p>
  </div>
</body>
</html>
      `.trim();

      const textContent = `
You're in! Welcome to QAIT.dev

Hey ${name}! Great news — your account has been approved. You now have full access to the platform.

Here's what you can do:
- Run AI-powered tests on your web apps
- Chat with our AI assistant to create test plans
- Track results and get detailed reports

Get started: ${loginUrl}

---

${name}, отличные новости — ваш аккаунт одобрен! Теперь у вас есть полный доступ к платформе QAIT.dev.

Что вы можете делать:
- Запускать AI-тесты для ваших веб-приложений
- Создавать тест-планы в чате с AI-ассистентом
- Отслеживать результаты и получать подробные отчёты

Войти: ${loginUrl}

---
© 2026 QAIT.dev - AI-Powered Testing Platform
      `.trim();

      logger.info('[EMAIL_SERVICE] Sending approval email', {
        recipientEmail: data.recipientEmail,
      });

      if (!process.env.SMTP_PASSWORD) {
        logger.error('[EMAIL_SERVICE] SMTP_PASSWORD not configured in .env');
        return { success: false, error: 'SMTP not configured' };
      }

      const transporter = this.createTransporter();

      await transporter.sendMail({
        from: '"QAIT.dev" <noreply@qait.dev>',
        to: data.recipientEmail,
        subject: "You're in! Your QAIT.dev account is approved",
        text: textContent,
        html: htmlContent,
      });

      logger.info('[EMAIL_SERVICE] Approval email sent successfully', {
        recipientEmail: data.recipientEmail,
      });

      return { success: true };
    } catch (error) {
      logger.error('[EMAIL_SERVICE] Failed to send approval email', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        recipientEmail: data.recipientEmail,
      });
      return { success: false, error: 'Failed to send approval email' };
    }
  }

  /**
   * Send rejection notification email to a user whose account has been rejected
   */
  static async sendRejectionEmail(data: RejectionEmailData): Promise<{ success: boolean; error?: string }> {
    try {
      const name = data.recipientName || 'there';

      const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Account Update</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 28px;">QAIT.dev</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 16px;">Account Update</p>
  </div>

  <div style="background: #ffffff; padding: 40px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
    <h2 style="color: #333; margin-top: 0;">Account Request Update</h2>

    <p style="font-size: 16px; color: #555;">
      Hey ${name}, thank you for your interest in QAIT.dev. Unfortunately, we were unable to approve your account at this time.
    </p>

    <p style="font-size: 16px; color: #555;">
      If you believe this was a mistake or have questions, feel free to reach out to our team at <a href="mailto:support@qait.dev" style="color: #667eea;">support@qait.dev</a>.
    </p>

    <!-- Russian version -->
    <div style="margin-top: 30px; padding-top: 25px; border-top: 1px solid #e0e0e0;">
      <p style="font-size: 13px; color: #999; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 0.5px;">Russian version</p>
      <p style="font-size: 15px; color: #555;">
        ${name}, спасибо за интерес к QAIT.dev. К сожалению, мы не смогли одобрить вашу заявку на данный момент.
      </p>
      <p style="font-size: 14px; color: #555;">
        Если вы считаете, что произошла ошибка, напишите нам: <a href="mailto:support@qait.dev" style="color: #667eea;">support@qait.dev</a>.
      </p>
    </div>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p>&copy; 2026 QAIT.dev - AI-Powered Testing Platform</p>
  </div>
</body>
</html>
      `.trim();

      const textContent = `
Account Request Update

Hey ${name}, thank you for your interest in QAIT.dev. Unfortunately, we were unable to approve your account at this time.

If you believe this was a mistake, contact us at support@qait.dev.

---

${name}, спасибо за интерес к QAIT.dev. К сожалению, мы не смогли одобрить вашу заявку на данный момент.

Если вы считаете, что произошла ошибка, напишите нам: support@qait.dev.

---
© 2026 QAIT.dev - AI-Powered Testing Platform
      `.trim();

      logger.info('[EMAIL_SERVICE] Sending rejection email', {
        recipientEmail: data.recipientEmail,
      });

      if (!process.env.SMTP_PASSWORD) {
        logger.error('[EMAIL_SERVICE] SMTP_PASSWORD not configured in .env');
        return { success: false, error: 'SMTP not configured' };
      }

      const transporter = this.createTransporter();

      await transporter.sendMail({
        from: '"QAIT.dev" <noreply@qait.dev>',
        to: data.recipientEmail,
        subject: 'QAIT.dev — Account Request Update',
        text: textContent,
        html: htmlContent,
      });

      logger.info('[EMAIL_SERVICE] Rejection email sent successfully', {
        recipientEmail: data.recipientEmail,
      });

      return { success: true };
    } catch (error) {
      logger.error('[EMAIL_SERVICE] Failed to send rejection email', {
        error: error instanceof Error ? error.message : String(error),
        recipientEmail: data.recipientEmail,
      });
      return { success: false, error: 'Failed to send rejection email' };
    }
  }

  /**
   * Send a generic email (used by notification jobs for support reports, test results, etc.)
   */
  static async sendGenericEmail(data: GenericEmailData): Promise<{ success: boolean; error?: string }> {
    try {
      logger.info('[EMAIL_SERVICE] Sending generic email', {
        recipientEmail: data.recipientEmail,
        subject: data.subject,
      });

      if (!process.env.SMTP_PASSWORD) {
        logger.error('[EMAIL_SERVICE] SMTP_PASSWORD not configured in .env');
        return { success: false, error: 'SMTP not configured' };
      }

      const transporter = this.createTransporter();

      await transporter.sendMail({
        from: '"QAIT.dev" <noreply@qait.dev>',
        to: data.recipientEmail,
        subject: data.subject,
        text: data.textContent,
        html: data.htmlContent || data.textContent,
      });

      logger.info('[EMAIL_SERVICE] Generic email sent successfully', {
        recipientEmail: data.recipientEmail,
      });

      return { success: true };
    } catch (error) {
      logger.error('[EMAIL_SERVICE] Failed to send generic email', {
        error: error instanceof Error ? error.message : String(error),
        recipientEmail: data.recipientEmail,
      });
      return { success: false, error: 'Failed to send email' };
    }
  }
}
