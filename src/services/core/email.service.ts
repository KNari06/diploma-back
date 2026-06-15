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

export interface NewUserSignupEmailData {
  userId: string;
  userEmail: string;
  userName?: string;
  provider: 'email' | 'google' | 'github' | 'gitlab' | 'bitbucket';
  signedUpAt: string;
  pendingUsersUrl: string;
}

export interface WelcomeEmailData {
  recipientEmail: string;
  recipientName?: string;
  frontendUrl: string;
  /** Configured free-plan credit grant the user will receive (e.g. 50). */
  freeCredits?: number;
}

export interface PlanPurchasedEmailData {
  recipientEmail: string;
  recipientName?: string;
  planName: string;
  /** Amount paid in the smallest currency unit (cents), as Stripe reports it. */
  amountCents: number;
  currency: string;
  /** Credits granted for this billing period, when known. */
  creditsIncluded?: number;
  frontendUrl: string;
}

export interface GeneralInfoEmailData {
  recipientEmail: string;
  recipientName?: string;
  /** Headline shown in the hero + used as the email subject when no subject given. */
  heading: string;
  /** Body copy. Plain text; rendered as paragraphs (newlines split paragraphs). */
  body: string;
  /** Optional subject override; falls back to `heading`. */
  subject?: string;
  /** Optional call-to-action button. */
  cta?: { label: string; url: string };
}

export interface PlanExpiringEmailData {
  recipientEmail: string;
  recipientName?: string;
  /** ISO timestamp when the current billing period ends. */
  expiresAt: string;
  /** true = auto-renews (heads-up); false = lapses (cancel_at_period_end). */
  willAutoRenew: boolean;
  frontendUrl: string;
}

export interface PaymentFailedEmailData {
  recipientEmail: string;
  recipientName?: string;
  amountCents: number;
  currency: string;
  frontendUrl: string;
}

export interface SubscriptionCanceledEmailData {
  recipientEmail: string;
  recipientName?: string;
  planName: string;
  /** ISO date the plan access ends, when known. */
  endsOn?: string | null;
  frontendUrl: string;
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

/**
 * Sanitize a URL for use in an href: only http(s)/mailto schemes pass, and the
 * result is HTML-escaped for attribute context. Anything else (javascript:,
 * data:, attribute breakout) collapses to '#'. Use for ANY caller-supplied URL
 * landing in a link (admin cta.url, test URLs).
 */
function safeUrl(url: string): string {
  const trimmed = (url || '').trim();
  if (!/^(https?:|mailto:)/i.test(trimmed)) return '#';
  return esc(trimmed);
}

// ─── Shared HTML Template Builder ───────────────────────────────────────

/**
 * Build a branded HTML email with the QAIT.dev header, status hero, content, and footer.
 * Uses table-based layout for full Outlook / Gmail / Apple Mail compatibility.
 */
function buildEmailTemplate(opts: {
  /** Inline SVG icon markup for the hero (see ICONS). Falls back to none. */
  heroIcon: string;
  /** Headline in the hero */
  heroTitle: string;
  /** Short subtitle under the hero headline */
  heroSubtitle?: string;
  /** Accent color for the icon stroke (defaults to neutral gray). */
  heroAccent?: string;
  /** HTML body content */
  bodyHtml: string;
  /** Optional CTA button */
  cta?: { label: string; url: string };
  /** Optional secondary link */
  secondaryLink?: { label: string; url: string };
}): string {
  // Light minimal style (Linear/Stripe). No tiffany fill, no dark hero —
  // tiffany lives only in the logo; the CTA is dark; the icon is a thin
  // bordered square holding a vector SVG (neutral, not filled).
  const iconColor = opts.heroAccent || BRAND.gray600;

  const ctaBlock = opts.cta
    ? `<table cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 4px;"><tr>
        <td align="center" style="border-radius:8px;background:${BRAND.dark};">
          <a href="${safeUrl(opts.cta.url)}" style="display:inline-block;padding:13px 28px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;font-family:'Segoe UI',Roboto,Arial,sans-serif;">${esc(opts.cta.label)} &#8594;</a>
        </td>
      </tr></table>
      ${opts.secondaryLink ? `<table cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 0;"><tr><td><a href="${safeUrl(opts.secondaryLink.url)}" style="color:${BRAND.gray500};font-size:13px;text-decoration:underline;font-family:'Segoe UI',Roboto,Arial,sans-serif;">${esc(opts.secondaryLink.label)}</a></td></tr></table>` : ''}`
    : '';

  const iconBlock = opts.heroIcon
    ? `<div style="width:46px;height:46px;border:1px solid ${BRAND.gray200};border-radius:10px;text-align:center;line-height:44px;margin:0 0 24px;color:${iconColor};">${opts.heroIcon}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<!--[if mso]><style>table{border-collapse:collapse;}td{font-family:Segoe UI,Arial,sans-serif;}</style><![endif]-->
</head>
<body style="font-family:'Segoe UI',Roboto,-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;line-height:1.6;color:${BRAND.gray700};margin:0;padding:0;background:${BRAND.gray100};-webkit-font-smoothing:antialiased;">

  <!-- Outer wrapper table for Outlook -->
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BRAND.gray100};"><tr><td align="center" style="padding:24px 16px;">
  <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border:1px solid ${BRAND.gray200};border-radius:12px;">

    <!-- Header bar -->
    <tr><td style="padding:28px 40px 0;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td><span style="color:${BRAND.dark};font-size:19px;font-weight:700;">QAIT</span><span style="color:${BRAND.tiffany};font-size:19px;font-weight:700;">.dev</span></td>
        <td style="text-align:right;"><span style="color:${BRAND.gray400};font-size:12px;">AI-Powered Testing</span></td>
      </tr></table>
    </td></tr>

    <!-- Hero (left-aligned, on white) -->
    <tr><td style="padding:36px 40px 0;">
      ${iconBlock}
      <h1 style="color:${BRAND.gray900};margin:0;font-size:24px;font-weight:600;line-height:1.25;letter-spacing:-0.3px;font-family:'Segoe UI',Roboto,Arial,sans-serif;">${opts.heroTitle}</h1>
      ${opts.heroSubtitle ? `<p style="color:${BRAND.gray500};margin:8px 0 0;font-size:14px;">${opts.heroSubtitle}</p>` : ''}
    </td></tr>

    <!-- Body -->
    <tr><td style="padding:28px 40px 36px;">
      ${opts.bodyHtml}
      ${ctaBlock}
    </td></tr>

    <!-- Footer -->
    <tr><td style="border-top:1px solid ${BRAND.gray100};padding:20px 40px;text-align:center;">
      <p style="margin:0 0 3px;font-size:12px;color:${BRAND.gray400};">&copy; 2026 QAIT.dev &mdash; AI-Powered Testing Platform</p>
      <p style="margin:0;font-size:11px;color:${BRAND.gray400};">You received this because you have notifications enabled.</p>
    </td></tr>

  </table>
  </td></tr></table>
</body></html>`;
}

/**
 * Inline SVG hero icons (email-safe: stroke-based, currentColor, 24px).
 * currentColor picks up the hero icon color set in buildEmailTemplate.
 * Clients that strip SVG simply show an empty bordered square — acceptable.
 */
const ICONS = {
  wave: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><path d="M7 11V6.5a1.5 1.5 0 0 1 3 0V10"/><path d="M10 10V5.5a1.5 1.5 0 0 1 3 0V10"/><path d="M13 10V6.5a1.5 1.5 0 0 1 3 0V11"/><path d="M16 11V8.5a1.5 1.5 0 0 1 3 0v4a7 7 0 0 1-7 7h-1.4a6 6 0 0 1-4.3-1.8L3 14.5a1.6 1.6 0 0 1 2.3-2.2L7 14"/></svg>',
  check: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
  megaphone: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><path d="M4 9v6h3l8 4V5L7 9H4z"/><path d="M18 9a3 3 0 0 1 0 6"/></svg>',
  alert: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/></svg>',
  x: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>',
  doc: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  user: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>',
};

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

/** Format a Stripe amount (cents) + currency code into a localized money string. */
function formatMoney(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: (currency || 'usd').toUpperCase(),
    }).format((amountCents || 0) / 100);
  } catch {
    // Unknown currency code → fall back to a plain decimal + raw code.
    return `${((amountCents || 0) / 100).toFixed(2)} ${(currency || '').toUpperCase()}`.trim();
  }
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
        user: 'yera@qait.dev',
        pass: process.env.SMTP_PASSWORD || '',
      },
    });
  }

  /**
   * Verify the SMTP credential at boot so a missing/dead password is loud at
   * startup instead of silently dropping every email. Non-fatal: logs and
   * returns — the server still starts (a broken mailer must not block boot).
   * Called once from startServer().
   */
  static async verifyConfig(): Promise<boolean> {
    if (!process.env.SMTP_PASSWORD) {
      logger.error('[EMAIL_SERVICE] SMTP_PASSWORD not configured — all emails will fail');
      return false;
    }
    try {
      await this.createTransporter().verify();
      logger.info('[EMAIL_SERVICE] SMTP credential verified — mailer ready');
      return true;
    } catch (error) {
      logger.error('[EMAIL_SERVICE] SMTP credential rejected — emails will fail until fixed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
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
        from: '"QAIT.dev" <yera@qait.dev>',
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

      const safeName = esc(name);
      const safeLoginUrl = esc(loginUrl);

      const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You're in! &mdash; QAIT.dev</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a2e;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f7;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.04);">

          <!-- HERO: CSS gradient banner -->
          <tr>
            <td style="background:#fde6f2;background-image:linear-gradient(135deg,#fde6f2 0%,#f5d6ff 45%,#e8d9ff 100%);padding:72px 32px;text-align:center;">
              <div style="font-size:14px;font-weight:600;color:#a855f7;letter-spacing:.5px;margin:0 0 16px;">
                &#x2728; QAIT.dev
              </div>
              <div style="font-size:52px;font-weight:800;color:#1a1a2e;line-height:1.1;letter-spacing:-1.5px;margin:0;">
                You&rsquo;re in! <span style="font-size:52px;">&#x1F973;</span>
              </div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:48px 48px 8px;">
              <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#1a1a2e;">
                Hi ${safeName},
              </p>

              <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#334155;">
                Great news &mdash; your QAIT.dev account has been approved. You now have full access to the platform.
              </p>

              <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#334155;">
                QAIT is an AI-powered testing platform that helps you ship faster with confidence. Run end-to-end tests on your web apps, chat with our AI to build test plans, and get detailed reports &mdash; all in one place.
              </p>

              <p style="margin:0 0 12px;font-size:15px;font-weight:600;color:#1a1a2e;">Here&rsquo;s what you can do next:</p>
              <ol style="margin:0 0 28px;padding-left:22px;font-size:15px;line-height:1.8;color:#334155;">
                <li>Connect your app and run your first AI test</li>
                <li>Chat with our AI assistant to generate a test plan</li>
                <li>Track results and get detailed bug reports</li>
              </ol>

              <!-- CTA -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 32px;">
                <tr>
                  <td align="center">
                    <a href="${safeLoginUrl}" style="display:inline-block;background:#1a1a2e;color:#ffffff;padding:14px 36px;border-radius:10px;font-weight:600;font-size:15px;text-decoration:none;">
                      Open QAIT.dev
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#64748b;">
                We&rsquo;re still in our early stages, so you might hit a few bugs or hiccups. If you do &mdash; reply to this email and we&rsquo;ll jump on it.
              </p>
            </td>
          </tr>

          <!-- Russian version -->
          <tr>
            <td style="padding:0 48px 8px;">
              <div style="border-top:1px solid #e2e8f0;padding-top:32px;">
                <p style="margin:0 0 12px;font-size:12px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.8px;">
                  &#x1F1F7;&#x1F1FA; Russian
                </p>
                <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1a2e;">
                  Привет, ${safeName}!
                </p>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
                  Отличные новости &mdash; ваш аккаунт QAIT.dev одобрен. Теперь у вас полный доступ к платформе.
                </p>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
                  QAIT &mdash; это AI-платформа для тестирования, которая помогает выпускать продукт быстрее и увереннее. Запускайте end-to-end тесты веб-приложений, создавайте тест-планы в чате с AI и получайте подробные отчёты &mdash; всё в одном месте.
                </p>
                <p style="margin:0 0 10px;font-size:14px;font-weight:600;color:#1a1a2e;">С чего начать:</p>
                <ol style="margin:0 0 24px;padding-left:22px;font-size:14px;line-height:1.8;color:#334155;">
                  <li>Подключите своё приложение и запустите первый AI-тест</li>
                  <li>Создайте тест-план в чате с AI-ассистентом</li>
                  <li>Отслеживайте результаты и получайте подробные отчёты о багах</li>
                </ol>
                <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#64748b;">
                  Мы ещё на ранних этапах, поэтому возможны баги или шероховатости. Если столкнётесь &mdash; просто ответьте на это письмо, разберёмся.
                </p>
              </div>
            </td>
          </tr>

          <!-- Sign-off -->
          <tr>
            <td style="padding:24px 48px 40px;">
              <p style="margin:0;font-size:15px;line-height:1.6;color:#334155;">
                Best,<br>
                <strong style="color:#1a1a2e;">The QAIT Team</strong>
              </p>
            </td>
          </tr>

          <!-- Fallback link -->
          <tr>
            <td style="padding:0 48px 32px;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:#94a3b8;">
                If the button above doesn&rsquo;t work, paste this link into your browser:<br>
                <a href="${safeLoginUrl}" style="color:#a855f7;word-break:break-all;text-decoration:none;">${safeLoginUrl}</a>
              </p>
            </td>
          </tr>

        </table>

        <!-- Footer -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;margin-top:16px;">
          <tr>
            <td style="text-align:center;padding:16px;font-size:12px;color:#94a3b8;">
              &copy; 2026 QAIT.dev &mdash; AI-Powered Testing Platform
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>
      `.trim();

      const textContent = `
You're in! 🥳

Hi ${name},

Great news — your QAIT.dev account has been approved. You now have full access to the platform.

QAIT is an AI-powered testing platform that helps you ship faster with confidence. Run end-to-end tests on your web apps, chat with our AI to build test plans, and get detailed reports — all in one place.

Here's what you can do next:
  1. Connect your app and run your first AI test
  2. Chat with our AI assistant to generate a test plan
  3. Track results and get detailed bug reports

Open QAIT.dev: ${loginUrl}

We're still in our early stages, so you might hit a few bugs or hiccups. If you do — reply to this email and we'll jump on it.

Best,
The QAIT Team

──────────────────────────────────────────

🇷🇺 Russian

Привет, ${name}!

Отличные новости — ваш аккаунт QAIT.dev одобрен. Теперь у вас полный доступ к платформе.

QAIT — это AI-платформа для тестирования, которая помогает выпускать продукт быстрее и увереннее. Запускайте end-to-end тесты веб-приложений, создавайте тест-планы в чате с AI и получайте подробные отчёты — всё в одном месте.

С чего начать:
  1. Подключите своё приложение и запустите первый AI-тест
  2. Создайте тест-план в чате с AI-ассистентом
  3. Отслеживайте результаты и получайте подробные отчёты о багах

Войти: ${loginUrl}

Мы ещё на ранних этапах, поэтому возможны баги или шероховатости. Если столкнётесь — просто ответьте на это письмо, разберёмся.

С уважением,
Команда QAIT

---
© 2026 QAIT.dev — AI-Powered Testing Platform
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
        from: '"QAIT.dev" <yera@qait.dev>',
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
        from: '"QAIT.dev" <yera@qait.dev>',
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
        from: '"QAIT.dev" <yera@qait.dev>',
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

  /**
   * Send a welcome email right after a user registers. Distinct from the
   * approval email: this fires at signup regardless of approval state, to
   * acknowledge the registration and point the user at next steps.
   */
  /** Build the welcome email HTML (shared by sender + preview). */
  static buildWelcomeHtml(data: WelcomeEmailData): string {
    const name = esc(data.recipientName || 'there');
    const creditsLine =
      typeof data.freeCredits === 'number' && data.freeCredits > 0
        ? `<p style="margin:0 0 20px;font-size:15px;color:${BRAND.gray600};line-height:1.7;">
             You&rsquo;ll get <strong style="color:${BRAND.gray900};">${data.freeCredits.toLocaleString('en-US')} free credits</strong> to get started &mdash; no card needed.
           </p>`
        : '';
    const bodyHtml = `
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND.gray700};">Hi ${name},</p>
        <p style="margin:0 0 16px;font-size:15px;color:${BRAND.gray600};line-height:1.7;">
          Thanks for signing up for QAIT.dev &mdash; an AI-powered testing platform that finds bugs in your web app on its own.
        </p>
        ${creditsLine}
        <p style="margin:0 0 12px;font-size:15px;font-weight:600;color:${BRAND.gray900};">Run your first test in under a minute:</p>
        <ol style="margin:0 0 8px;padding-left:22px;font-size:15px;line-height:1.8;color:${BRAND.gray600};">
          <li>Paste your app&rsquo;s URL &mdash; our AI explores it and discovers test cases automatically</li>
          <li>Review the discovered tests and run them in one click</li>
          <li>Get detailed reports with screenshots and the exact step that failed</li>
        </ol>`;
    return buildEmailTemplate({
      heroIcon: '',
      heroTitle: 'Welcome to QAIT.dev',
      bodyHtml,
      cta: { label: 'Start your first test', url: data.frontendUrl },
    });
  }

  static async sendWelcomeEmail(data: WelcomeEmailData): Promise<{ success: boolean; error?: string }> {
    try {
      if (!process.env.SMTP_PASSWORD) {
        logger.error('[EMAIL_SERVICE] SMTP_PASSWORD not configured in .env');
        return { success: false, error: 'SMTP not configured' };
      }

      const html = this.buildWelcomeHtml(data);

      await this.createTransporter().sendMail({
        from: '"QAIT.dev" <yera@qait.dev>',
        to: data.recipientEmail,
        subject: 'Welcome to QAIT.dev',
        text: `Hi ${data.recipientName || 'there'},\n\nThanks for signing up for QAIT.dev. Get started: ${data.frontendUrl}`,
        html,
      });

      logger.info('[EMAIL_SERVICE] Welcome email sent successfully', { recipientEmail: data.recipientEmail });
      return { success: true };
    } catch (error) {
      logger.error('[EMAIL_SERVICE] Failed to send welcome email', {
        error: error instanceof Error ? error.message : String(error),
        recipientEmail: data.recipientEmail,
      });
      return { success: false, error: 'Failed to send welcome email' };
    }
  }

  /**
   * Send a purchase confirmation email when a subscription payment succeeds.
   * Stripe sends its own receipt; this is the branded QAIT confirmation that
   * names the plan and credits granted.
   */
  /** Build the plan-purchased email HTML (shared by sender + preview). */
  static buildPlanPurchasedHtml(data: PlanPurchasedEmailData): string {
    const name = esc(data.recipientName || 'there');
    const amount = formatMoney(data.amountCents, data.currency);
    const rows = [
      detailRow('Plan', badge(esc(data.planName), BRAND.tiffany)),
      detailRow('Amount', amount),
      ...(data.creditsIncluded ? [detailRow('Credits', `${data.creditsIncluded.toLocaleString('en-US')}`)] : []),
    ];
    const bodyHtml = `
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND.gray700};">Hi ${name},</p>
        <p style="margin:0 0 20px;font-size:15px;color:${BRAND.gray600};line-height:1.6;">
          Your payment was successful and your plan is now active. Thank you for upgrading QAIT.dev!
        </p>
        ${detailsTable(rows)}`;
    return buildEmailTemplate({
      heroIcon: '',
      heroTitle: 'Payment confirmed',
      heroSubtitle: `${esc(data.planName)} plan is active`,
      bodyHtml,
      cta: { label: 'Go to Dashboard', url: data.frontendUrl },
    });
  }

  static async sendPlanPurchasedEmail(data: PlanPurchasedEmailData): Promise<{ success: boolean; error?: string }> {
    try {
      if (!process.env.SMTP_PASSWORD) {
        logger.error('[EMAIL_SERVICE] SMTP_PASSWORD not configured in .env');
        return { success: false, error: 'SMTP not configured' };
      }

      const amount = formatMoney(data.amountCents, data.currency);
      const html = this.buildPlanPurchasedHtml(data);

      await this.createTransporter().sendMail({
        from: '"QAIT.dev" <yera@qait.dev>',
        to: data.recipientEmail,
        subject: `Payment confirmed — ${data.planName} plan`,
        text: `Hi ${data.recipientName || 'there'},\n\nYour payment of ${amount} for the ${data.planName} plan was successful. Your plan is now active.`,
        html,
      });

      logger.info('[EMAIL_SERVICE] Plan purchased email sent successfully', { recipientEmail: data.recipientEmail });
      return { success: true };
    } catch (error) {
      logger.error('[EMAIL_SERVICE] Failed to send plan purchased email', {
        error: error instanceof Error ? error.message : String(error),
        recipientEmail: data.recipientEmail,
      });
      return { success: false, error: 'Failed to send plan purchased email' };
    }
  }

  /**
   * Send a general/announcement info email to a single user. The heading +
   * body are caller-supplied (e.g. from an admin broadcast); both are escaped
   * before rendering.
   */
  /** Build the general-info email HTML (shared by sender + preview). */
  static buildGeneralInfoHtml(data: GeneralInfoEmailData): string {
    const name = esc(data.recipientName || 'there');
    const paragraphs = data.body
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p style="margin:0 0 16px;font-size:15px;color:${BRAND.gray600};line-height:1.6;">${esc(p).replace(/\n/g, '<br>')}</p>`)
      .join('');
    const bodyHtml = `
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND.gray700};">Hi ${name},</p>
        ${paragraphs}`;
    return buildEmailTemplate({
      heroIcon: '',
      heroTitle: esc(data.heading),
      bodyHtml,
      cta: data.cta,
    });
  }

  static async sendGeneralInfoEmail(data: GeneralInfoEmailData): Promise<{ success: boolean; error?: string }> {
    try {
      if (!process.env.SMTP_PASSWORD) {
        logger.error('[EMAIL_SERVICE] SMTP_PASSWORD not configured in .env');
        return { success: false, error: 'SMTP not configured' };
      }

      const html = this.buildGeneralInfoHtml(data);

      await this.createTransporter().sendMail({
        from: '"QAIT.dev" <yera@qait.dev>',
        to: data.recipientEmail,
        subject: data.subject || data.heading,
        text: `Hi ${data.recipientName || 'there'},\n\n${data.body}`,
        html,
      });

      logger.info('[EMAIL_SERVICE] General info email sent successfully', { recipientEmail: data.recipientEmail });
      return { success: true };
    } catch (error) {
      logger.error('[EMAIL_SERVICE] Failed to send general info email', {
        error: error instanceof Error ? error.message : String(error),
        recipientEmail: data.recipientEmail,
      });
      return { success: false, error: 'Failed to send general info email' };
    }
  }

  /** "Your plan expires soon" reminder (driven by the daily ExpiringPlansJob). */
  static buildPlanExpiringHtml(data: PlanExpiringEmailData): string {
    const name = esc(data.recipientName || 'there');
    const dateStr = formatDate(data.expiresAt);
    const lead = data.willAutoRenew
      ? `Your QAIT.dev plan renews on <strong style="color:${BRAND.gray900};">${dateStr}</strong>. No action needed &mdash; this is just a heads-up. If you want to make changes, you can manage your plan any time.`
      : `Your QAIT.dev plan is set to end on <strong style="color:${BRAND.gray900};">${dateStr}</strong> and won&rsquo;t renew. To keep running tests without interruption, renew before then.`;
    const bodyHtml = `
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND.gray700};">Hi ${name},</p>
        <p style="margin:0 0 20px;font-size:15px;color:${BRAND.gray600};line-height:1.7;">${lead}</p>`;
    return buildEmailTemplate({
      heroIcon: '',
      heroTitle: data.willAutoRenew ? 'Your plan renews soon' : 'Your plan expires soon',
      heroSubtitle: dateStr,
      bodyHtml,
      cta: { label: 'Manage your plan', url: data.frontendUrl },
    });
  }

  static async sendPlanExpiringEmail(data: PlanExpiringEmailData): Promise<{ success: boolean; error?: string }> {
    try {
      if (!process.env.SMTP_PASSWORD) {
        logger.error('[EMAIL_SERVICE] SMTP_PASSWORD not configured in .env');
        return { success: false, error: 'SMTP not configured' };
      }
      const subject = data.willAutoRenew ? 'Your QAIT.dev plan renews soon' : 'Your QAIT.dev plan expires soon';
      await this.createTransporter().sendMail({
        from: '"QAIT.dev" <yera@qait.dev>',
        to: data.recipientEmail,
        subject,
        text: `Hi ${data.recipientName || 'there'},\n\n${subject} (${formatDate(data.expiresAt)}). Manage your plan: ${data.frontendUrl}`,
        html: this.buildPlanExpiringHtml(data),
      });
      logger.info('[EMAIL_SERVICE] Plan expiring email sent successfully', { recipientEmail: data.recipientEmail });
      return { success: true };
    } catch (error) {
      logger.error('[EMAIL_SERVICE] Failed to send plan expiring email', {
        error: error instanceof Error ? error.message : String(error),
        recipientEmail: data.recipientEmail,
      });
      return { success: false, error: 'Failed to send plan expiring email' };
    }
  }

  /** Payment-failed (card declined / dunning) notice. */
  static buildPaymentFailedHtml(data: PaymentFailedEmailData): string {
    const name = esc(data.recipientName || 'there');
    // Only name the amount when we actually have one; a $0.00 invoice reads oddly.
    const amountPhrase =
      data.amountCents > 0
        ? ` of <strong style="color:${BRAND.gray900};">${formatMoney(data.amountCents, data.currency)}</strong>`
        : '';
    const bodyHtml = `
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND.gray700};">Hi ${name},</p>
        <p style="margin:0 0 20px;font-size:15px;color:${BRAND.gray600};line-height:1.7;">
          We couldn&rsquo;t process your payment${amountPhrase} for QAIT.dev. This usually means your card expired or was declined.
        </p>
        <p style="margin:0 0 20px;font-size:15px;color:${BRAND.gray600};line-height:1.7;">
          Please update your payment method to keep your plan active &mdash; we&rsquo;ll retry automatically once it&rsquo;s fixed.
        </p>`;
    return buildEmailTemplate({
      heroIcon: '',
      heroTitle: 'Payment failed',
      bodyHtml,
      cta: { label: 'Update payment method', url: data.frontendUrl },
    });
  }

  static async sendPaymentFailedEmail(data: PaymentFailedEmailData): Promise<{ success: boolean; error?: string }> {
    try {
      if (!process.env.SMTP_PASSWORD) {
        logger.error('[EMAIL_SERVICE] SMTP_PASSWORD not configured in .env');
        return { success: false, error: 'SMTP not configured' };
      }
      await this.createTransporter().sendMail({
        from: '"QAIT.dev" <yera@qait.dev>',
        to: data.recipientEmail,
        subject: 'Action needed: your QAIT.dev payment failed',
        text: `Hi ${data.recipientName || 'there'},\n\nWe couldn't process your payment of ${formatMoney(data.amountCents, data.currency)}. Update your payment method: ${data.frontendUrl}`,
        html: this.buildPaymentFailedHtml(data),
      });
      logger.info('[EMAIL_SERVICE] Payment failed email sent successfully', { recipientEmail: data.recipientEmail });
      return { success: true };
    } catch (error) {
      logger.error('[EMAIL_SERVICE] Failed to send payment failed email', {
        error: error instanceof Error ? error.message : String(error),
        recipientEmail: data.recipientEmail,
      });
      return { success: false, error: 'Failed to send payment failed email' };
    }
  }

  /** Subscription canceled / will-not-renew notice. */
  static buildSubscriptionCanceledHtml(data: SubscriptionCanceledEmailData): string {
    const name = esc(data.recipientName || 'there');
    const endsLine = data.endsOn
      ? ` You&rsquo;ll keep access until <strong style="color:${BRAND.gray900};">${formatDate(data.endsOn)}</strong>.`
      : '';
    const bodyHtml = `
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND.gray700};">Hi ${name},</p>
        <p style="margin:0 0 20px;font-size:15px;color:${BRAND.gray600};line-height:1.7;">
          Your <strong style="color:${BRAND.gray900};">${esc(data.planName)}</strong> plan on QAIT.dev has been canceled and won&rsquo;t renew.${endsLine}
        </p>
        <p style="margin:0 0 20px;font-size:15px;color:${BRAND.gray600};line-height:1.7;">
          Changed your mind? You can resubscribe any time and pick up right where you left off.
        </p>`;
    return buildEmailTemplate({
      heroIcon: '',
      heroTitle: 'Your plan was canceled',
      heroSubtitle: esc(data.planName),
      bodyHtml,
      cta: { label: 'Resubscribe', url: data.frontendUrl },
    });
  }

  static async sendSubscriptionCanceledEmail(
    data: SubscriptionCanceledEmailData
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!process.env.SMTP_PASSWORD) {
        logger.error('[EMAIL_SERVICE] SMTP_PASSWORD not configured in .env');
        return { success: false, error: 'SMTP not configured' };
      }
      await this.createTransporter().sendMail({
        from: '"QAIT.dev" <yera@qait.dev>',
        to: data.recipientEmail,
        subject: `Your QAIT.dev ${data.planName} plan was canceled`,
        text: `Hi ${data.recipientName || 'there'},\n\nYour ${data.planName} plan was canceled and won't renew. Resubscribe any time: ${data.frontendUrl}`,
        html: this.buildSubscriptionCanceledHtml(data),
      });
      logger.info('[EMAIL_SERVICE] Subscription canceled email sent successfully', { recipientEmail: data.recipientEmail });
      return { success: true };
    } catch (error) {
      logger.error('[EMAIL_SERVICE] Failed to send subscription canceled email', {
        error: error instanceof Error ? error.message : String(error),
        recipientEmail: data.recipientEmail,
      });
      return { success: false, error: 'Failed to send subscription canceled email' };
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
      heroIcon: ICONS.x,
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
      heroIcon: ICONS.alert,
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
      bug: ICONS.alert,
      feature: ICONS.check,
      question: ICONS.doc,
      other: ICONS.doc,
    };
    const catIcon = categoryIcons[data.category] || ICONS.doc;

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

  /**
   * Build HTML email notifying admins about a newly registered user awaiting approval.
   */
  static buildNewUserSignupEmail(data: NewUserSignupEmailData): { subject: string; text: string; html: string } {
    const displayName = data.userName?.trim() || data.userEmail.split('@')[0];
    const subject = `New signup pending approval: ${displayName}`;

    const providerColors: Record<string, string> = {
      email: BRAND.blue,
      google: BRAND.red,
      github: BRAND.gray700,
      gitlab: BRAND.orange,
      bitbucket: BRAND.blue,
    };
    const providerColor = providerColors[data.provider] || BRAND.gray500;

    const rows = [
      detailRow('Name', esc(displayName)),
      detailRow('Email', `<span style="color:${BRAND.gray700};">${esc(data.userEmail)}</span>`),
      detailRow('Provider', badge(data.provider, providerColor)),
      detailRow('Status', badge('Pending Approval', BRAND.orange)),
      detailRow('User ID', codePill(data.userId)),
      detailRow('Signed Up', formatDate(data.signedUpAt)),
    ];

    const ctaBlock = `
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:28px 0 0;">
        <tr><td align="center">
          <a href="${esc(data.pendingUsersUrl)}" style="display:inline-block;background:${BRAND.tiffany};color:#ffffff;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;text-decoration:none;">Review pending users</a>
        </td></tr>
      </table>`;

    const html = buildEmailTemplate({
      heroIcon: ICONS.user,
      heroTitle: 'New user awaiting approval',
      heroSubtitle: `${esc(displayName)} just signed up via ${esc(data.provider)}`,
      heroAccent: BRAND.gray600,
      bodyHtml: `${detailsTable(rows)}${ctaBlock}`,
    });

    const text = [
      `New user awaiting approval`,
      ``,
      `Name: ${displayName}`,
      `Email: ${data.userEmail}`,
      `Provider: ${data.provider}`,
      `User ID: ${data.userId}`,
      `Signed Up: ${formatDate(data.signedUpAt)}`,
      ``,
      `Review at: ${data.pendingUsersUrl}`,
    ].join('\n');

    return { subject, text, html };
  }
}
