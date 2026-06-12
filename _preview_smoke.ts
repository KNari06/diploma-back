import { EmailService } from './src/services/core/email.service';
const w = EmailService.buildWelcomeHtml({ recipientEmail: 'a@b.com', recipientName: 'Alex', frontendUrl: 'http://x' });
const p = EmailService.buildPlanPurchasedHtml({ recipientEmail: 'a@b.com', recipientName: 'Alex', planName: 'Pro', amountCents: 4900, currency: 'usd', creditsIncluded: 5000, frontendUrl: 'http://x' });
const g = EmailService.buildGeneralInfoHtml({ recipientEmail: 'a@b.com', recipientName: 'Alex', heading: 'Hi <b>x</b>', body: 'Line one.\n\nLine two <script>.', cta: { label: 'Go', url: 'http://x' } });
console.log('welcome_ok=' + (w.includes('Welcome to QAIT.dev') && w.length > 500));
console.log('purchase_ok=' + (p.includes('Payment Confirmed') && p.includes('$49.00') && p.includes('5,000')));
console.log('general_xss_safe=' + (g.includes('&lt;script&gt;') && !g.includes('<script>')));
