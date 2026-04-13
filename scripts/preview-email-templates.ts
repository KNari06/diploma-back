/**
 * Preview email templates in the browser.
 * Run: npx tsx scripts/preview-email-templates.ts
 * Opens http://localhost:3333 with all 3 email templates.
 */
import http from 'http';
import { EmailService } from '../src/services/core/email.service';

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

const templates = [
  { name: 'Test Failed', html: testFailed.html, subject: testFailed.subject },
  { name: 'Critical Issues', html: criticalIssues.html, subject: criticalIssues.subject },
  { name: 'Support Report', html: supportReport.html, subject: supportReport.subject },
];

const indexPage = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Email Template Preview</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: #f0f0f3; }
  .nav { background: #1a1a2e; padding: 16px 32px; display: flex; gap: 12px; align-items: center; }
  .nav h1 { color: #fff; font-size: 18px; margin: 0 24px 0 0; }
  .nav a { color: rgba(255,255,255,.7); text-decoration: none; padding: 8px 16px; border-radius: 6px; font-size: 14px; }
  .nav a:hover, .nav a.active { background: rgba(255,255,255,.1); color: #fff; }
  iframe { width: 100%; height: calc(100vh - 56px); border: none; }
</style></head>
<body>
  <div class="nav">
    <h1>Email Templates</h1>
    ${templates.map((t, i) => `<a href="/template/${i}" target="preview">${t.name}</a>`).join('')}
  </div>
  <iframe name="preview" src="/template/0"></iframe>
</body></html>`;

const server = http.createServer((req, res) => {
  const match = req.url?.match(/^\/template\/(\d+)$/);
  if (match) {
    const idx = parseInt(match[1], 10);
    const t = templates[idx];
    if (t) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(t.html);
      return;
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(indexPage);
});

server.listen(3555, () => {
  console.log('\n  Email template preview ready:');
  console.log('  http://localhost:3555\n');
});
