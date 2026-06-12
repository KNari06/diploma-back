/**
 * Preview email templates + Telegram messages in the browser.
 * Run: npx tsx scripts/preview-email-templates.ts
 * Opens http://localhost:3555
 */
import http from 'http';
import { EmailService } from '../src/services/core/email.service';

// ─── Email templates ────────────────────────────────────────────────────

const testFailed = EmailService.buildTestFailedEmail({
  testId: 'c3105977-765a-4535-8b35-4b9480ad790c',
  testUrl: 'https://app.example.com/dashboard',
  errorMessage: 'Failed after 3 retries: Element not found — selector "button#submit" did not match any element within 30s timeout.',
  browsers: ['chrome', 'firefox'],
  startedAt: new Date(Date.now() - 120_000).toISOString(),
  failedAt: new Date().toISOString(),
  dashboardUrl: 'http://localhost:3000/tests/c3105977-765a-4535-8b35-4b9480ad790c',
});

const criticalIssues = EmailService.buildCriticalIssuesEmail({
  testId: 'a1b2c3d4-5678-9012-abcd-ef1234567890',
  testUrl: 'https://shop.example.com/checkout',
  bugs: [
    { severity: 'critical', message: 'Payment form submits without card validation — users can place orders with empty payment fields', category: 'functional' },
    { severity: 'critical', message: 'Session token exposed in URL query parameter after login redirect', category: 'security' },
    { severity: 'high', message: 'Cart total shows $0.00 when switching currency — price calculation broken', category: 'functional' },
  ],
  dashboardUrl: 'http://localhost:3000/tests/a1b2c3d4-5678-9012-abcd-ef1234567890',
});

const supportReport = EmailService.buildSupportReportEmail({
  reportId: 'rpt-98765432',
  title: 'Test recorder freezes on SPA navigation',
  category: 'bug',
  details: 'When recording a test on a React SPA, the recorder freezes after the first client-side navigation. The page loads fine but the recorder stops capturing actions. This happens consistently on Chrome 120+ with the latest extension version.',
  userEmail: 'john@company.com',
  userId: 'usr-11223344-aabb-ccdd',
  workspaceName: 'Acme Corp',
  view: 'Test Editor',
  submittedAt: new Date().toISOString(),
});

const emailTemplates = [
  { name: 'Test Failed', html: testFailed.html },
  { name: 'Critical Issues', html: criticalIssues.html },
  { name: 'Support Report', html: supportReport.html },
];

// Lifecycle emails — the senders build their HTML via these shared build*Html
// methods, so previewing them here renders exactly what users receive.
emailTemplates.push(
  {
    name: 'Welcome',
    html: EmailService.buildWelcomeHtml({
      recipientEmail: 'alex@example.com',
      recipientName: 'Alex',
      frontendUrl: 'http://localhost:3000',
    }),
  },
  {
    name: 'Plan Purchased',
    html: EmailService.buildPlanPurchasedHtml({
      recipientEmail: 'alex@example.com',
      recipientName: 'Alex',
      planName: 'Pro',
      amountCents: 4900,
      currency: 'usd',
      creditsIncluded: 5000,
      frontendUrl: 'http://localhost:3000',
    }),
  },
  {
    name: 'General Info',
    html: EmailService.buildGeneralInfoHtml({
      recipientEmail: 'alex@example.com',
      recipientName: 'Alex',
      heading: 'Scheduled maintenance on June 20',
      body: 'We’ll be performing scheduled maintenance on June 20, 02:00–04:00 UTC.\n\nDuring this window test runs may be delayed. No action is needed on your side.',
      cta: { label: 'View status page', url: 'http://localhost:3000/status' },
    }),
  }
);

// ─── Telegram message simulation ────────────────────────────────────────
// We import the builder to generate real messages, then render them
// inside a Telegram-like UI.

// Simulate what telegram-notify.ts would produce:
function escTg(t: string) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const tgTestFailed = [
  `\u274C <b>Test Failed</b>`,
  ``,
  `<b>URL:</b> ${escTg('https://app.example.com/dashboard')}`,
  `<b>Browsers:</b> chrome, firefox`,
  `<b>Duration:</b> 2m 0s`,
  ``,
  `<b>Error:</b>`,
  `<code>${escTg('Failed after 3 retries: Element not found — selector "button#submit" did not match any element within 30s timeout.')}</code>`,
  ``,
  `<a href="#">View test results \u2192</a>`,
].join('\n');

const tgCriticalIssues = [
  `\u26A0\uFE0F <b>3 Critical Issues Found</b>`,
  ``,
  `<b>URL:</b> ${escTg('https://shop.example.com/checkout')}`,
  ``,
  `\uD83D\uDD34 <b>CRITICAL</b> (functional) ${escTg('Payment form submits without card validation \u2014 users can place orders with empty payment fields')}`,
  `\uD83D\uDD34 <b>CRITICAL</b> (security) ${escTg('Session token exposed in URL query parameter after login redirect')}`,
  `\uD83D\uDFE0 <b>HIGH</b> (functional) ${escTg('Cart total shows $0.00 when switching currency \u2014 price calculation broken')}`,
  ``,
  `<a href="#">View AI analysis \u2192</a>`,
].join('\n');

const telegramMessages = [
  { name: 'Test Failed', html: tgTestFailed },
  { name: 'Critical Issues', html: tgCriticalIssues },
];

// ─── Telegram-like renderer ─────────────────────────────────────────────

function renderTelegramPhone(messages: typeof telegramMessages): string {
  const bubbles = messages.map(m => {
    // Convert Telegram HTML to browser-renderable HTML
    const rendered = m.html
      .replace(/\n/g, '<br>')
      // Telegram <code> → styled span
      .replace(/<code>/g, '<span class="tg-code">')
      .replace(/<\/code>/g, '</span>');

    return `
      <div class="tg-bubble">
        <div class="tg-avatar">Q</div>
        <div class="tg-content">
          <div class="tg-name">QAIT.dev Bot</div>
          <div class="tg-text">${rendered}</div>
          <div class="tg-time">${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}</div>
        </div>
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0e1621; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; padding: 20px; font-family: -apple-system, system-ui, sans-serif; }

  .phone {
    width: 400px;
    background: #17212b;
    border-radius: 24px;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0,0,0,.5);
  }

  /* Header */
  .tg-header {
    background: #242f3d;
    padding: 14px 20px;
    display: flex;
    align-items: center;
    gap: 12px;
    border-bottom: 1px solid #1a2433;
  }
  .tg-header-avatar {
    width: 40px; height: 40px; border-radius: 50%;
    background: linear-gradient(135deg, #0ab8b2, #099e99);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-size: 16px;
  }
  .tg-header-info h3 { color: #fff; font-size: 15px; font-weight: 600; }
  .tg-header-info p { color: #6d7f8f; font-size: 12px; margin-top: 1px; }

  /* Chat area */
  .tg-chat {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 200px;
    background: #0e1621;
    background-image:
      radial-gradient(circle at 20% 30%, rgba(10,184,178,.03) 0%, transparent 50%),
      radial-gradient(circle at 80% 70%, rgba(10,184,178,.02) 0%, transparent 50%);
  }

  /* Message bubble */
  .tg-bubble {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  .tg-avatar {
    width: 32px; height: 32px; border-radius: 50%;
    background: linear-gradient(135deg, #0ab8b2, #099e99);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-size: 13px;
    flex-shrink: 0;
  }
  .tg-content {
    background: #182533;
    border-radius: 4px 16px 16px 16px;
    padding: 10px 14px 6px;
    max-width: 330px;
    position: relative;
  }
  .tg-name {
    color: #0ab8b2;
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .tg-text {
    color: #e1e3e6;
    font-size: 14px;
    line-height: 1.45;
    word-break: break-word;
  }
  .tg-text b { color: #fff; }
  .tg-text a { color: #6ab2f2; text-decoration: none; }
  .tg-text a:hover { text-decoration: underline; }
  .tg-text .tg-code {
    background: #1e2c3a;
    color: #e06c75;
    padding: 2px 6px;
    border-radius: 4px;
    font-family: 'SF Mono', Monaco, Consolas, monospace;
    font-size: 13px;
    display: inline;
  }
  .tg-time {
    color: #576572;
    font-size: 11px;
    text-align: right;
    margin-top: 4px;
  }

  /* Input bar */
  .tg-input {
    background: #17212b;
    padding: 10px 16px;
    display: flex;
    align-items: center;
    gap: 10px;
    border-top: 1px solid #1a2433;
  }
  .tg-input-field {
    flex: 1;
    background: #242f3d;
    border: none;
    border-radius: 20px;
    padding: 10px 16px;
    color: #8b9bab;
    font-size: 14px;
    outline: none;
  }
  .tg-input-btn {
    width: 36px; height: 36px;
    background: none; border: none;
    color: #6d7f8f; font-size: 20px; cursor: pointer;
  }
</style>
</head>
<body>
  <div class="phone">
    <div class="tg-header">
      <div class="tg-header-avatar">Q</div>
      <div class="tg-header-info">
        <h3>QAIT.dev Bot</h3>
        <p>bot &middot; last seen recently</p>
      </div>
    </div>
    <div class="tg-chat">
      ${bubbles}
    </div>
    <div class="tg-input">
      <input class="tg-input-field" placeholder="Message" readonly>
      <button class="tg-input-btn">\u{1F3A4}</button>
    </div>
  </div>
</body></html>`;
}

// ─── Server ─────────────────────────────────────────────────────────────

const indexPage = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Notification Preview</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f0f1a; color: #fff; }
  .nav {
    background: #1a1a2e;
    padding: 14px 32px;
    display: flex;
    gap: 8px;
    align-items: center;
    border-bottom: 1px solid #2a2a3e;
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .nav h1 { font-size: 17px; margin-right: 24px; font-weight: 600; }
  .nav h1 span { color: #0ab8b2; }
  .sep { width: 1px; height: 24px; background: #2a2a3e; margin: 0 8px; }
  .tab {
    color: rgba(255,255,255,.5);
    text-decoration: none;
    padding: 7px 14px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    border: none;
    background: none;
    font-family: inherit;
    transition: all .15s;
  }
  .tab:hover { background: rgba(255,255,255,.06); color: #fff; }
  .tab.active { background: rgba(10,184,178,.15); color: #0ab8b2; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .5px;
    margin-left: 6px;
    vertical-align: middle;
  }
  .badge-email { background: #2563eb22; color: #60a5fa; }
  .badge-tg { background: #0ab8b222; color: #0ab8b2; }
  iframe { width: 100%; height: calc(100vh - 52px); border: none; background: #0e1621; }
</style>
<script>
  function load(url, btn) {
    document.querySelector('iframe').src = url;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
  }
</script>
</head>
<body>
  <div class="nav">
    <h1>QAIT<span>.dev</span> Notifications</h1>
    <div class="sep"></div>
    <button class="tab active" onclick="load('/email/0', this)">Test Failed <span class="badge badge-email">Email</span></button>
    <button class="tab" onclick="load('/email/1', this)">Critical Issues <span class="badge badge-email">Email</span></button>
    <button class="tab" onclick="load('/email/2', this)">Support Report <span class="badge badge-email">Email</span></button>
    <button class="tab" onclick="load('/email/3', this)">Welcome <span class="badge badge-email">Email</span></button>
    <button class="tab" onclick="load('/email/4', this)">Plan Purchased <span class="badge badge-email">Email</span></button>
    <button class="tab" onclick="load('/email/5', this)">General Info <span class="badge badge-email">Email</span></button>
    <div class="sep"></div>
    <button class="tab" onclick="load('/telegram', this)">Telegram <span class="badge badge-tg">TG</span></button>
  </div>
  <iframe src="/email/0"></iframe>
</body></html>`;

const telegramPage = renderTelegramPhone(telegramMessages);

const server = http.createServer((req, res) => {
  // Email templates
  const emailMatch = req.url?.match(/^\/email\/(\d+)$/);
  if (emailMatch) {
    const t = emailTemplates[parseInt(emailMatch[1], 10)];
    if (t) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(t.html);
      return;
    }
  }

  // Telegram preview
  if (req.url === '/telegram') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(telegramPage);
    return;
  }

  // Old routes redirect
  const oldMatch = req.url?.match(/^\/template\/(\d+)$/);
  if (oldMatch) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(emailTemplates[parseInt(oldMatch[1], 10)]?.html || 'Not found');
    return;
  }

  // Index
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(indexPage);
});

server.listen(3555, () => {
  console.log('\n  Notification preview ready:');
  console.log('  http://localhost:3555\n');
});
