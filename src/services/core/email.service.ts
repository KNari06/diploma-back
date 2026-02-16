import nodemailer from 'nodemailer';
import { logger } from '@/utils/core/logger';

export interface WorkspaceInviteEmailData {
  inviteId: string;
  workspaceId: string;
  workspaceName?: string;
  invitedByName?: string;
  recipientEmail: string;
  role: 'full_access' | 'view';
  frontendUrl: string;
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
}
