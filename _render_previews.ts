import fs from 'fs';
import { EmailService } from './src/services/core/email.service';
const out = '/tmp/qait-emails';
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(`${out}/welcome.html`, EmailService.buildWelcomeHtml({ recipientEmail: 'alex@example.com', recipientName: 'Alex', frontendUrl: 'http://localhost:3000' }));
fs.writeFileSync(`${out}/plan-purchased.html`, EmailService.buildPlanPurchasedHtml({ recipientEmail: 'alex@example.com', recipientName: 'Alex', planName: 'Pro', amountCents: 4900, currency: 'usd', creditsIncluded: 5000, frontendUrl: 'http://localhost:3000' }));
fs.writeFileSync(`${out}/general-info.html`, EmailService.buildGeneralInfoHtml({ recipientEmail: 'alex@example.com', recipientName: 'Alex', heading: 'Scheduled maintenance on June 20', body: 'We will perform maintenance on June 20, 02:00-04:00 UTC.\n\nTest runs may be delayed. No action needed.', cta: { label: 'View status page', url: 'http://localhost:3000/status' } }));
console.log('WROTE=' + out);
