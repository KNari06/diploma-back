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

// ─── Email Template Types ───────────────────────────────────────────────

export interface TestFailedEmailData {
  testId: string;
  testUrl: string;
  errorMessage: string;
  browsers: string[];
  startedAt?: string | null;
  failedAt?: string | null;
  dashboardUrl: string;
}

export interface CriticalIssuesEmailData {
  testId: string;
  testUrl: string;
  bugs: Array<{
    severity: string;
    message: string;
    category?: string;
  }>;
  dashboardUrl: string;
}

export interface SupportReportEmailData {
  reportId: string;
  title: string;
  category: string;
  details: string;
  userEmail: string;
  userId: string;
  workspaceName?: string;
  view?: string;
  submittedAt: string;
}

// ─── Brand constants ────────────────────────────────────────────────────
const BRAND = {
  tiffany: '#0ab8b2',
  tiffanyDark: '#099e99',
  tiffanyLight: '#e6f9f8',
  dark: '#1a1a2e',
  darkAlt: '#16213e',
  red: '#dc2626',
  redBg: '#fef2f2',
  redBorder: '#fecaca',
  orange: '#ea580c',
  orangeBg: '#fff7ed',
  yellow: '#ca8a04',
  yellowBg: '#fefce8',
  green: '#16a34a',
  greenBg: '#f0fdf4',
  blue: '#2563eb',
  blueBg: '#eff6ff',
  purple: '#7c3aed',
  purpleBg: '#f5f3ff',
  gray50: '#f8fafc',
  gray100: '#f1f5f9',
  gray200: '#e2e8f0',
  gray400: '#94a3b8',
  gray500: '#64748b',
  gray600: '#475569',
  gray700: '#334155',
  gray900: '#0f172a',
};

/** Badge background colors — Outlook-safe solid values (no 8-digit hex) */
const BADGE_BG: Record<string, string> = {
  [BRAND.red]: BRAND.redBg,
  [BRAND.orange]: BRAND.orangeBg,
  [BRAND.yellow]: BRAND.yellowBg,
  [BRAND.green]: BRAND.greenBg,
  [BRAND.blue]: BRAND.blueBg,
  [BRAND.purple]: BRAND.purpleBg,
  [BRAND.gray500]: BRAND.gray100,
  [BRAND.gray600]: BRAND.gray100,
};

// ─── HTML safety ────────────────────────────────────────────────────────

/** Escape HTML special chars to prevent XSS from user-supplied data */
function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Shared HTML Template Builder ───────────────────────────────────────

/**
 * Build a branded HTML email with the QAIT.dev header, status hero, content, and footer.
 * Uses table-based layout for full Outlook / Gmail / Apple Mail compatibility.
 */
function buildEmailTemplate(opts: {
  /** Icon emoji for the status hero */
  heroIcon: string;
  /** Headline in the status hero */
  heroTitle: string;
  /** Short subtitle under the hero headline */
  heroSubtitle?: string;
  /** Accent color for the hero icon bg */
  heroAccent?: string;
  /** HTML body content */
  bodyHtml: string;
  /** Optional CTA button */
  cta?: { label: string; url: string };
  /** Optional secondary link */
  secondaryLink?: { label: string; url: string };
}): string {
  const accentBg = BADGE_BG[opts.heroAccent || ''] || BRAND.tiffanyLight;

  const ctaBlock = opts.cta
    ? `<table cellpadding="0" cellspacing="0" border="0" style="margin:32px auto 8px;"><tr>
        <td align="center" style="border-radius:8px;background:${BRAND.tiffany};">
          <a href="${opts.cta.url}" style="display:inline-block;padding:14px 40px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;letter-spacing:.3px;font-family:'Segoe UI',Roboto,Arial,sans-serif;">${opts.cta.label} &#8594;</a>
        </td>
      </tr></table>
      ${opts.secondaryLink ? `<table cellpadding="0" cellspacing="0" border="0" style="margin:4px auto 0;"><tr><td align="center"><a href="${opts.secondaryLink.url}" style="color:${BRAND.gray500};font-size:13px;text-decoration:underline;font-family:'Segoe UI',Roboto,Arial,sans-serif;">${opts.secondaryLink.label}</a></td></tr></table>` : ''}`
    : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<!--[if mso]><style>table{border-collapse:collapse;}td{font-family:Segoe UI,Arial,sans-serif;}</style><![endif]-->
</head>
<body style="font-family:'Segoe UI',Roboto,-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;line-height:1.6;color:${BRAND.gray700};margin:0;padding:0;background:${BRAND.gray100};-webkit-font-smoothing:antialiased;">

  <!-- Outer wrapper table for Outlook -->
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BRAND.gray100};"><tr><td align="center" style="padding:24px 16px;">
  <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;">

    <!-- Header bar -->
    <tr><td style="background:${BRAND.dark};padding:18px 28px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td><span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.5px;">QAIT</span><span style="color:${BRAND.tiffany};font-size:20px;font-weight:700;">.dev</span></td>
        <td style="text-align:right;"><span style="color:${BRAND.gray400};font-size:12px;">AI-Powered Testing</span></td>
      </tr></table>
    </td></tr>

    <!-- Hero section -->
    <tr><td style="background:${BRAND.dark};padding:32px 28px 28px;text-align:center;">
      <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr>
        <td align="center">
          <div style="width:56px;height:56px;line-height:56px;border-radius:28px;background:${accentBg};font-size:28px;text-align:center;margin:0 auto 16px;"><!--[if mso]>&nbsp;<![endif]-->${opts.heroIcon}<!--[if mso]>&nbsp;<![endif]--></div>
          <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:600;line-height:1.3;font-family:'Segoe UI',Roboto,Arial,sans-serif;">${opts.heroTitle}</h1>
          ${opts.heroSubtitle ? `<p style="color:${BRAND.gray400};margin:8px 0 0;font-size:14px;">${opts.heroSubtitle}</p>` : ''}
        </td>
      </tr></table>
    </td></tr>

    <!-- Body card -->
    <tr><td style="background:#ffffff;padding:32px 28px;border-left:1px solid ${BRAND.gray200};border-right:1px solid ${BRAND.gray200};">
      ${opts.bodyHtml}
      ${ctaBlock}
    </td></tr>

    <!-- Footer -->
    <tr><td style="background:${BRAND.gray50};border:1px solid ${BRAND.gray200};border-top:none;padding:20px 28px;text-align:center;">
      <p style="margin:0 0 4px;font-size:12px;color:${BRAND.gray400};">&copy; 2026 QAIT.dev &mdash; AI-Powered Testing Platform</p>
      <p style="margin:0;font-size:11px;color:${BRAND.gray400};">You received this because you have notifications enabled.</p>
    </td></tr>

  </table>
  </td></tr></table>
</body></html>`;
}

/** Render a labeled detail row */
function detailRow(label: string, value: string): string {
  return `<tr>
    <td style="padding:10px 14px;font-size:13px;color:${BRAND.gray500};white-space:nowrap;vertical-align:top;border-bottom:1px solid ${BRAND.gray100};">${label}</td>
    <td style="padding:10px 14px;font-size:14px;color:${BRAND.gray700};border-bottom:1px solid ${BRAND.gray100};">${value}</td>
  </tr>`;
}

function detailsTable(rows: string[]): string {
  return `<table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;border:1px solid ${BRAND.gray200};margin:20px 0;">${rows.join('')}</table>`;
}

function badge(text: string, color: string): string {
  const bg = BADGE_BG[color] || BRAND.gray100;
  return `<span style="display:inline-block;background:${bg};color:${color};padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;">${esc(text)}</span>`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '&#8212;';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  } catch {
    return esc(iso);
  }
}

function codePill(text: string): string {
  return `<code style="background:${BRAND.gray100};padding:3px 8px;border-radius:4px;font-size:12px;font-family:'SF Mono',Monaco,Consolas,monospace;color:${BRAND.gray600};">${esc(text)}</code>`;
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

  // ─── Rich Email Builders ────────────────────────────────────────────

  /**
   * Build HTML email for test failure notifications.
   */
  static buildTestFailedEmail(data: TestFailedEmailData): { subject: string; text: string; html: string } {
    const shortId = data.testId.slice(0, 8);
    const safeUrl = esc(data.testUrl);
    const subject = `Test Failed: ${data.testUrl} (${shortId})`;

    // Duration calc
    let duration = '&#8212;';
    if (data.startedAt && data.failedAt) {
      const ms = new Date(data.failedAt).getTime() - new Date(data.startedAt).getTime();
      const secs = Math.floor(ms / 1000);
      duration = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
    }

    const rows = [
      detailRow('Status', badge('Failed', BRAND.red)),
      detailRow('URL', `<a href="${esc(data.testUrl)}" style="color:${BRAND.tiffany};text-decoration:none;word-break:break-all;">${safeUrl}</a>`),
      detailRow('Browsers', data.browsers.map(b => badge(b, BRAND.gray600)).join(' ') || '&#8212;'),
      detailRow('Duration', duration),
      detailRow('Test ID', codePill(shortId)),
      detailRow('Started', formatDate(data.startedAt)),
      detailRow('Failed At', formatDate(data.failedAt)),
    ];

    const errorBlock = `
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0 0;">
        <tr><td><p style="margin:0 0 10px;font-size:13px;font-weight:600;color:${BRAND.gray600};text-transform:uppercase;letter-spacing:.5px;">Error Details</p></td></tr>
        <tr><td style="background:${BRAND.redBg};border:1px solid ${BRAND.redBorder};border-left:4px solid ${BRAND.red};padding:16px 18px;">
          <p style="margin:0;font-size:14px;color:#991b1b;word-break:break-word;line-height:1.5;">${esc(data.errorMessage)}</p>
        </td></tr>
      </table>`;

    const html = buildEmailTemplate({
      heroIcon: '&#x2716;',
      heroTitle: 'Test Execution Failed',
      heroSubtitle: safeUrl,
      heroAccent: BRAND.red,
      bodyHtml: `${detailsTable(rows)}${errorBlock}`,
      cta: { label: 'View Test Results', url: data.dashboardUrl },
      secondaryLink: { label: 'Open test URL', url: data.testUrl },
    });

    const text = [
      `Test Failed: ${data.testUrl}`,
      ``,
      `Test ID: ${data.testId}`,
      `URL: ${data.testUrl}`,
      `Browsers: ${data.browsers.join(', ')}`,
      `Duration: ${duration}`,
      `Started: ${formatDate(data.startedAt)}`,
      `Failed: ${formatDate(data.failedAt)}`,
      ``,
      `Error: ${data.errorMessage}`,
      ``,
      `View results: ${data.dashboardUrl}`,
    ].join('\n');

    return { subject, text, html };
  }

  /**
   * Build HTML email for critical issues found by AI analysis.
   */
  static buildCriticalIssuesEmail(data: CriticalIssuesEmailData): { subject: string; text: string; html: string } {
    const shortId = data.testId.slice(0, 8);
    const safeUrl = esc(data.testUrl);
    const subject = `Critical Issues Found: ${data.testUrl} (${shortId})`;

    const severityColors: Record<string, string> = {
      critical: BRAND.red,
      high: BRAND.orange,
      medium: BRAND.yellow,
      low: BRAND.green,
    };

    // Summary stats
    const counts: Record<string, number> = {};
    for (const bug of data.bugs) {
      counts[bug.severity] = (counts[bug.severity] || 0) + 1;
    }
    const statBoxes = Object.entries(counts).map(([sev, count]) => {
      const color = severityColors[sev] || BRAND.red;
      return `<td style="text-align:center;padding:12px 8px;">
        <p style="margin:0;font-size:24px;font-weight:700;color:${color};">${count}</p>
        <p style="margin:4px 0 0;font-size:11px;color:${BRAND.gray500};text-transform:uppercase;letter-spacing:.3px;">${esc(sev)}</p>
      </td>`;
    }).join('');

    const statsBlock = `<table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background:${BRAND.gray50};border:1px solid ${BRAND.gray200};margin:0 0 24px;">
      <tr>${statBoxes}</tr>
    </table>`;

    // URL info
    const urlRow = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:20px;">
      <tr><td>
        <p style="margin:0 0 4px;font-size:12px;color:${BRAND.gray500};text-transform:uppercase;letter-spacing:.5px;">Tested URL</p>
        <a href="${esc(data.testUrl)}" style="color:${BRAND.tiffany};font-size:15px;text-decoration:none;word-break:break-all;">${safeUrl}</a>
        <span style="margin-left:8px;">${codePill(shortId)}</span>
      </td></tr>
    </table>`;

    // Bug cards — table-based layout (no flexbox)
    const bugsHtml = data.bugs.map((bug, i) => {
      const color = severityColors[bug.severity] || BRAND.red;
      return `<tr><td style="padding:14px 16px;${i > 0 ? `border-top:1px solid ${BRAND.gray200};` : ''}">
        <p style="margin:0 0 8px;">${badge(bug.severity, color)}${bug.category ? ` ${badge(bug.category, BRAND.gray600)}` : ''}</p>
        <p style="margin:0;font-size:14px;color:${BRAND.gray700};line-height:1.5;">${esc(bug.message)}</p>
      </td></tr>`;
    }).join('');

    const bugsBlock = `
      <p style="margin:0 0 10px;font-size:13px;font-weight:600;color:${BRAND.gray600};text-transform:uppercase;letter-spacing:.5px;">Issues Found</p>
      <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border:1px solid ${BRAND.gray200};background:#ffffff;">${bugsHtml}</table>`;

    const html = buildEmailTemplate({
      heroIcon: '&#x26A0;',
      heroTitle: `${data.bugs.length} Critical Issue${data.bugs.length > 1 ? 's' : ''} Detected`,
      heroSubtitle: 'AI analysis found issues requiring attention',
      heroAccent: BRAND.orange,
      bodyHtml: `${urlRow}${statsBlock}${bugsBlock}`,
      cta: { label: 'View AI Analysis', url: data.dashboardUrl },
      secondaryLink: { label: 'Open test URL', url: data.testUrl },
    });

    const text = [
      `Critical Issues Found: ${data.testUrl}`,
      ``,
      `Test ID: ${data.testId}`,
      `Issues: ${data.bugs.length} critical`,
      ``,
      ...data.bugs.map((b, i) => `${i + 1}. [${b.severity.toUpperCase()}]${b.category ? ` (${b.category})` : ''} ${b.message}`),
      ``,
      `View analysis: ${data.dashboardUrl}`,
    ].join('\n');

    return { subject, text, html };
  }

  /**
   * Build HTML email for support/user report notifications (admin-facing).
   */
  static buildSupportReportEmail(data: SupportReportEmailData): { subject: string; text: string; html: string } {
    const subject = `New User Report: ${data.title}`;

    const categoryColors: Record<string, string> = {
      bug: BRAND.red,
      feature: BRAND.blue,
      question: BRAND.purple,
      other: BRAND.gray500,
    };
    const catColor = categoryColors[data.category] || BRAND.gray500;
    const categoryIcons: Record<string, string> = {
      bug: '&#x1F41B;',
      feature: '&#x2728;',
      question: '&#x2753;',
      other: '&#x1F4AC;',
    };
    const catIcon = categoryIcons[data.category] || '&#x1F4AC;';

    const rows = [
      detailRow('Category', badge(data.category, catColor)),
      detailRow('User', `<span style="color:${BRAND.gray700};">${esc(data.userEmail)}</span> ${codePill(data.userId.slice(0, 8))}`),
      ...(data.workspaceName ? [detailRow('Workspace', esc(data.workspaceName))] : []),
      ...(data.view ? [detailRow('View', esc(data.view))] : []),
      detailRow('Report ID', codePill(data.reportId)),
      detailRow('Submitted', formatDate(data.submittedAt)),
    ];

    const detailsBlock = `
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0 0;">
        <tr><td><p style="margin:0 0 10px;font-size:13px;font-weight:600;color:${BRAND.gray600};text-transform:uppercase;letter-spacing:.5px;">Report Details</p></td></tr>
        <tr><td style="background:${BRAND.gray50};border:1px solid ${BRAND.gray200};padding:18px;">
          <p style="margin:0;font-size:14px;color:${BRAND.gray700};white-space:pre-wrap;line-height:1.6;">${esc(data.details)}</p>
        </td></tr>
      </table>`;

    const html = buildEmailTemplate({
      heroIcon: catIcon,
      heroTitle: esc(data.title),
      heroSubtitle: `${esc(data.category.charAt(0).toUpperCase() + data.category.slice(1))} report from ${esc(data.userEmail)}`,
      heroAccent: catColor,
      bodyHtml: `${detailsTable(rows)}${detailsBlock}`,
    });

    const text = [
      `New User Report: ${data.title}`,
      ``,
      `Category: ${data.category}`,
      `User: ${data.userEmail} (${data.userId})`,
      ...(data.workspaceName ? [`Workspace: ${data.workspaceName}`] : []),
      ...(data.view ? [`View: ${data.view}`] : []),
      `Report ID: ${data.reportId}`,
      `Submitted: ${formatDate(data.submittedAt)}`,
      ``,
      `Details:`,
      data.details,
    ].join('\n');

    return { subject, text, html };
  }
}
