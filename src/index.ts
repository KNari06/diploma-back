import adminTracesRoutes from '@/api/admin/admin-traces.route';
import allureImportRoutes from '@/api/allure-import/allure-import.route';
import analyticsRoutes from '@/api/analytics/analytics.route';
import emailInboxRoutes from '@/api/email-inbox/email-inbox.routes';
import explorationsRoutes from '@/api/explorations/explorations.route';
import dashboardRoutes from '@/api/dashboard/dashboard.route';
import apiConfigRoutes from '@/api/apiConfig/apiConfig.routes';
import apiTestRoutes from '@/api/apiTest/apiTest.route';
import apiFlowSpecRoutes from '@/api/apiFlowSpec/apiFlowSpec.route';
import authRoutes from '@/api/auth/auth.route';
import chatRoutes from '@/api/chat/chat.route';
import feedbackRoutes from '@/api/chat/feedback.route';
import fixturesRoutes from '@/api/fixtures/fixtures.route';
import flowsRoutes from '@/api/flows/flows.route';
import gitIntegrationRoutes from '@/api/gitIntegration/git-integration.route';
import intelligentTestRoutes from '@/api/intelligentTest/intelligentTest.route';
import integrationsRoutes from '@/api/integrations/integrations.route';
import jiraRoutes from '@/api/jira/jira.route';
import kbRoutes from '@/api/kb/kb.route';
import skillsRoutes from '@/api/kb/skills.route';
import patternsRoutes from '@/api/kb/patterns.route';
import rulesReloadRoutes from '@/api/kb/rules-reload.route';
import manualTestRoutes from '@/api/manualTest/manualTest.route';
import queueStatusRoutes from '@/api/manualTest/queue-status.route';
import modulesRoutes from '@/api/modules/modules.route';
import announcementsRoutes from '@/api/announcements/announcements.routes';
import notificationsRoutes from '@/api/notifications/notifications.routes';
import platformsRoutes from '@/api/platforms/platforms.route';
import playwrightRoutes from '@/api/playwright/playwright.route';
import previewRoutes from '@/api/preview/preview.route';
import mobileRoutes from '@/api/mobile/mobile.route';
import projectRoutes from '@/api/project/project.routes';
import regressionPlansRoutes from '@/api/regression-plans/plans.route';
import regressionRoutes from '@/api/regression/regression.route';
import { getSharedReport } from '@/api/regression/regression.controller';
import { sharedReportRateLimiter } from '@/middleware/rate-limiter.middleware';
import reportsRoutes from '@/api/reports/reports.route';
import savedTestCasesRoutes from '@/api/saved-test-cases/saved-test-cases.route';
import testsRoutes from '@/api/tests/tests.route';
import schedulesRoutes from '@/api/schedules/schedules.route';
import stripeRoutes from '@/api/stripe/stripe.routes';
import supportRoutes from '@/api/support/support.routes';
import testVisualizationRoutes from '@/api/testVisualization/testVisualization.route';
import userRoutes from '@/api/user/user.routes';
import waitlistRoutes from '@/api/waitlist/waitlist.route';
import investorRoutes from '@/api/investor/investor.route';
import workspaceRoutes from '@/api/workspace/workspace.routes';
import invitesRoutes from '@/api/workspace/invites.routes';
import testCaseRoutes from '@/api/test-case/test-case.routes';
import testResourceRoutes from '@/api/test-resource/test-resource.routes';
import { registerBuiltinResourceAdapters } from '@/services/test-resource';
import { requireAuth, requireApproved } from '@/middleware/auth.middleware';
import { swaggerSpec } from '@/config/api/swagger';
import { env, isDevelopment } from '@/config/environment/env';
import { QueueManager } from '@/config/infrastructure/queues';
import { testSupabaseAuthHealth, testSupabaseConnection } from '@/db/supabase';
import { SystemHealthMonitor } from '@/services/system/system-health-monitor.service';
import { errorHandler, notFoundHandler } from '@/utils/core/error-handler';
import { logger, morganStream, formatError } from '@/utils/core/logger';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';

// Create Express app
const app = express();

// Trust proxy for correct IP detection (important for IP-based anonymous identification)
app.set('trust proxy', true);

// Security middleware with Swagger-friendly CSP
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Disable strict CSP for Swagger UI and documentation routes
  if (req.path.startsWith('/api/docs') || req.path.startsWith('/api/features') || req.path.startsWith('/api/architecture')) {
    return next();
  }

  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  })(req, res, next);
});

// Relaxed security for Swagger UI
app.use('/api/docs', (req: express.Request, res: express.Response, next: express.NextFunction) => {
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  })(req, res, next);
}, swaggerUi.serve);

// Relaxed security for documentation routes (login forms need inline scripts)
app.use(['/api/features', '/api/architecture'], (req: express.Request, res: express.Response, next: express.NextFunction) => {
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // Allow inline scripts for login form
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  })(req, res, next);
});

// CORS configuration
const DEV_ALLOWED_ORIGINS = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const uniqueOrigins = (origins: string[]): string[] => Array.from(new Set(origins));

const getCorsOrigins = (): boolean | string[] => {
  if (isDevelopment) {
    return true;
  }

  const allowedOrigins = process.env.ALLOWED_ORIGINS;
  const devOrigins = DEV_ALLOWED_ORIGINS;

  try {
    const configuredOrigins = (allowedOrigins && typeof allowedOrigins === 'string')
      ? allowedOrigins.split(',').map(origin => origin.trim()).filter(Boolean)
      : [];
    const merged = uniqueOrigins([...configuredOrigins, ...devOrigins]);
    return merged.length > 0 ? merged : false;
  } catch (error) {
    logger.warn('Failed to parse ALLOWED_ORIGINS, disabling CORS', {
      error: error instanceof Error ? error.message : String(error),
      ALLOWED_ORIGINS: allowedOrigins, // Use local variable instead of undefined
    });
    // Keep dev origins allowed even if parsing failed
    return devOrigins;
  }
};

// ✅ FIX: CORS middleware with guaranteed headers on all responses
app.use(cors({
  origin: getCorsOrigins(),
  credentials: true,
  // Include HEAD for common browser/proxy behavior. Keep TRACE/CONNECT disabled for security.
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-ID', 'X-Admin-Key'],
}));

// ✅ FIX: Helper function to check if origin is allowed
const isOriginAllowed = (origin: string | undefined): boolean => {
  if (!origin) return false;

  const corsOrigins = getCorsOrigins();
  if (corsOrigins === true) return true; // Development mode - allow all
  if (corsOrigins === false) return false; // CORS disabled

  return Array.isArray(corsOrigins) && corsOrigins.includes(origin);
};

// ✅ FIX: Additional middleware to ensure CORS headers on all responses (including errors)
// This prevents CORS errors when backend returns 502/503 during deployment
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const origin = req.headers.origin;
  const allowedOrigin = isOriginAllowed(origin);

  if (allowedOrigin && origin) {
    // Store original send/end methods
    const originalSend = res.send;
    const originalJson = res.json;
    const originalStatus = res.status;

    // Override res.status to ensure CORS headers are set
    res.status = function (code: number) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-ID, X-Admin-Key');
      return originalStatus.call(this, code);
    };

    // Override res.json to ensure CORS headers
    res.json = function (body: any) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-ID, X-Admin-Key');
      return originalJson.call(this, body);
    };

    // Override res.send to ensure CORS headers
    res.send = function (body?: any) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-ID, X-Admin-Key');
      return originalSend.call(this, body);
    };
  }
  next();
});

// Rate limiting - disable express-rate-limit since we use custom rate limiter
// const limiter = rateLimit({
//   windowMs: env.RATE_LIMIT_WINDOW_MS,
//   max: env.RATE_LIMIT_MAX_REQUESTS,
//   message: {
//     success: false,
//     error: 'Too many requests, please try again later',
//     code: 'RATE_LIMIT_EXCEEDED',
//     timestamp: new Date().toISOString(),
//   },
//   standardHeaders: true,
//   legacyHeaders: false,
// });

// app.use(limiter); // Disabled - using custom rate limiter in middleware

// Raw body parser for Stripe webhook (must be before express.json())
app.use(`/api/${env.API_VERSION}/stripe/webhook`, express.raw({ type: 'application/json' }));

// Body parsing middleware
// IMPORTANT: GitHub webhook signature requires raw body (Buffer)
app.use(`/api/${env.API_VERSION}/git-integrations/webhook`, express.raw({ type: 'application/json', limit: '10mb' }));
// Fallback when reverse proxy strips /api (e.g. nginx proxy_pass with trailing slash)
app.use(`/${env.API_VERSION}/git-integrations/webhook`, express.raw({ type: 'application/json', limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware
app.use(morgan(env.LOG_FORMAT, { stream: morganStream }));

// Swagger documentation setup (middleware already registered above)
app.use('/api/docs', swaggerUi.setup(swaggerSpec, {
  customCss: `
    .swagger-ui .topbar { display: none }

    /* Theme Toggle Button */
    .theme-toggle-container {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 1000;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .theme-toggle-btn {
      padding: 8px 16px;
      background: #49cc90;
      border: 1px solid #49cc90;
      border-radius: 4px;
      color: #ffffff;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .theme-toggle-btn:hover {
      background: #5dd69f;
      border-color: #5dd69f;
    }

    .theme-toggle-btn svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }

    /* Light Mode (Default) */
    .swagger-ui:not(.dark-mode) {
      background: #ffffff;
      color: #3b4151;
    }

    .swagger-ui:not(.dark-mode) .info {
      background: #fafafa;
      border-color: #e4e4e4;
    }

    .swagger-ui:not(.dark-mode) .info .title {
      color: #3b4151;
    }

    .swagger-ui:not(.dark-mode) .info .description p,
    .swagger-ui:not(.dark-mode) .info .description a {
      color: #3b4151;
    }

    .swagger-ui:not(.dark-mode) .info .description code {
      background: #f0f0f0;
      color: #3b4151;
      padding: 2px 4px;
      border-radius: 2px;
    }

    .swagger-ui:not(.dark-mode) .opblock-tag {
      color: #3b4151;
      border-color: #e4e4e4;
    }

    .swagger-ui:not(.dark-mode) .opblock-tag small {
      color: #808080;
    }

    .swagger-ui:not(.dark-mode) .opblock .opblock-summary .opblock-summary-path,
    .swagger-ui:not(.dark-mode) .opblock .opblock-summary .opblock-summary-operation-id {
      color: #3b4151;
    }

    .swagger-ui:not(.dark-mode) .opblock-body {
      background: #ffffff;
      border-color: #e4e4e4;
    }

    .swagger-ui:not(.dark-mode) .opblock-description-wrapper p,
    .swagger-ui:not(.dark-mode) .opblock-external-docs p,
    .swagger-ui:not(.dark-mode) .opblock-title_normal p {
      color: #3b4151;
    }

    .swagger-ui:not(.dark-mode) .parameter__name,
    .swagger-ui:not(.dark-mode) .parameter__type,
    .swagger-ui:not(.dark-mode) .parameter__in {
      color: #3b4151;
    }

    .swagger-ui:not(.dark-mode) .parameter__name.required::after {
      color: #f93e3e;
    }

    .swagger-ui:not(.dark-mode) .btn {
      background: #ffffff;
      border-color: #d9d9d9;
      color: #3b4151;
    }

    .swagger-ui:not(.dark-mode) .btn:hover {
      background: #f0f0f0;
    }

    .swagger-ui:not(.dark-mode) input[type=text],
    .swagger-ui:not(.dark-mode) input[type=email],
    .swagger-ui:not(.dark-mode) input[type=password],
    .swagger-ui:not(.dark-mode) textarea,
    .swagger-ui:not(.dark-mode) select {
      background: #ffffff;
      border-color: #d9d9d9;
      color: #3b4151;
    }

    .swagger-ui:not(.dark-mode) input[type=text]:focus,
    .swagger-ui:not(.dark-mode) input[type=email]:focus,
    .swagger-ui:not(.dark-mode) input[type=password]:focus,
    .swagger-ui:not(.dark-mode) textarea:focus,
    .swagger-ui:not(.dark-mode) select:focus {
      border-color: #4990e2;
      background: #ffffff;
    }

    .swagger-ui:not(.dark-mode) .response-col_status,
    .swagger-ui:not(.dark-mode) .response-col_links {
      color: #3b4151;
    }

    .swagger-ui:not(.dark-mode) .microlight {
      background: #f8f8f8;
      color: #3b4151;
    }

    .swagger-ui:not(.dark-mode) .scheme-container {
      background: #fafafa;
      border-color: #e4e4e4;
    }

    .swagger-ui:not(.dark-mode) .model {
      background: #fafafa;
      color: #3b4151;
    }

    .swagger-ui:not(.dark-mode) .model-title {
      color: #3b4151;
    }

    .swagger-ui:not(.dark-mode) .prop-format {
      color: #808080;
    }

    .swagger-ui:not(.dark-mode) table thead tr td,
    .swagger-ui:not(.dark-mode) table thead tr th {
      background: #fafafa;
      color: #3b4151;
      border-color: #e4e4e4;
    }

    .swagger-ui:not(.dark-mode) table tbody tr td {
      border-color: #e4e4e4;
      color: #3b4151;
    }

    .swagger-ui:not(.dark-mode) .renderedMarkdown p,
    .swagger-ui:not(.dark-mode) .renderedMarkdown code,
    .swagger-ui:not(.dark-mode) .renderedMarkdown pre {
      color: #3b4151;
    }

    .swagger-ui:not(.dark-mode) .renderedMarkdown code {
      background: #f0f0f0;
      color: #3b4151;
    }

    .swagger-ui:not(.dark-mode) .renderedMarkdown pre {
      background: #f8f8f8;
      border-color: #e4e4e4;
    }

    .swagger-ui:not(.dark-mode) .dialog-ux .modal-ux {
      background: #ffffff;
    }

    .swagger-ui:not(.dark-mode) .dialog-ux .modal-ux-header {
      background: #fafafa;
      border-color: #e4e4e4;
    }

    .swagger-ui:not(.dark-mode) .dialog-ux .modal-ux-header h3 {
      color: #3b4151;
    }

    .swagger-ui:not(.dark-mode) .dialog-ux .modal-ux-content {
      background: #ffffff;
      color: #3b4151;
    }

    .swagger-ui:not(.dark-mode) .dialog-ux .modal-ux-content input,
    .swagger-ui:not(.dark-mode) .dialog-ux .modal-ux-content textarea {
      background: #ffffff;
      border-color: #d9d9d9;
      color: #3b4151;
    }

    /* Dark Mode */
    .swagger-ui.dark-mode {
      background: #1e1e1e;
      color: #e1e1e1;
    }

    .swagger-ui.dark-mode .info {
      background: #252525;
      border-color: #3a3a3a;
    }

    .swagger-ui.dark-mode .info .title {
      color: #ffffff;
    }

    .swagger-ui.dark-mode .info .description p,
    .swagger-ui.dark-mode .info .description a,
    .swagger-ui.dark-mode .info .description code {
      color: #d4d4d4;
    }

    .swagger-ui.dark-mode .info .description code {
      background: #2a2a2a;
      padding: 2px 4px;
      border-radius: 2px;
    }

    .swagger-ui.dark-mode .opblock-tag {
      color: #ffffff;
      border-color: #3a3a3a;
    }

    .swagger-ui.dark-mode .opblock-tag small {
      color: #b8b8b8;
    }

    .swagger-ui.dark-mode .opblock.opblock-post {
      background: rgba(73, 204, 144, 0.1);
      border-color: #49cc90;
    }

    .swagger-ui.dark-mode .opblock.opblock-get {
      background: rgba(97, 175, 254, 0.1);
      border-color: #61affe;
    }

    .swagger-ui.dark-mode .opblock.opblock-put {
      background: rgba(252, 161, 48, 0.1);
      border-color: #fca130;
    }

    .swagger-ui.dark-mode .opblock.opblock-delete {
      background: rgba(249, 62, 62, 0.1);
      border-color: #f93e3e;
    }

    .swagger-ui.dark-mode .opblock.opblock-patch {
      background: rgba(80, 227, 194, 0.1);
      border-color: #50e3c2;
    }

    .swagger-ui.dark-mode .opblock .opblock-summary {
      background: transparent;
    }

    .swagger-ui.dark-mode .opblock .opblock-summary .opblock-summary-method {
      background: #1e1e1e;
    }

    .swagger-ui.dark-mode .opblock .opblock-summary .opblock-summary-path,
    .swagger-ui.dark-mode .opblock .opblock-summary .opblock-summary-operation-id {
      color: #e1e1e1;
    }

    .swagger-ui.dark-mode .opblock-body {
      background: #252525;
      border-color: #3a3a3a;
    }

    .swagger-ui.dark-mode .opblock-description-wrapper p,
    .swagger-ui.dark-mode .opblock-external-docs p,
    .swagger-ui.dark-mode .opblock-title_normal p {
      color: #d4d4d4;
    }

    .swagger-ui.dark-mode .parameter__name,
    .swagger-ui.dark-mode .parameter__type,
    .swagger-ui.dark-mode .parameter__in {
      color: #b8b8b8;
    }

    .swagger-ui.dark-mode .parameter__name.required::after {
      color: #f93e3e;
    }

    .swagger-ui.dark-mode .btn {
      background: #3a3a3a;
      border-color: #4a4a4a;
      color: #e1e1e1;
    }

    .swagger-ui.dark-mode .btn:hover {
      background: #4a4a4a;
    }

    .swagger-ui.dark-mode .btn.authorize {
      background: #49cc90;
      border-color: #49cc90;
      color: #1e1e1e;
    }

    .swagger-ui.dark-mode .btn.authorize:hover {
      background: #5dd69f;
    }

    .swagger-ui.dark-mode .btn.execute {
      background: #4990e2;
      border-color: #4990e2;
    }

    .swagger-ui.dark-mode .btn.execute:hover {
      background: #5a9fe3;
    }

    .swagger-ui.dark-mode input[type=text],
    .swagger-ui.dark-mode input[type=email],
    .swagger-ui.dark-mode input[type=password],
    .swagger-ui.dark-mode textarea,
    .swagger-ui.dark-mode select {
      background: #2a2a2a;
      border-color: #3a3a3a;
      color: #e1e1e1;
    }

    .swagger-ui.dark-mode input[type=text]:focus,
    .swagger-ui.dark-mode input[type=email]:focus,
    .swagger-ui.dark-mode input[type=password]:focus,
    .swagger-ui.dark-mode textarea:focus,
    .swagger-ui.dark-mode select:focus {
      border-color: #4990e2;
      background: #1e1e1e;
    }

    .swagger-ui.dark-mode .response-col_status {
      color: #b8b8b8;
    }

    .swagger-ui.dark-mode .response-col_links {
      color: #b8b8b8;
    }

    .swagger-ui.dark-mode .response .response-col_status {
      color: #49cc90;
    }

    .swagger-ui.dark-mode .response.highlighted .response-col_status {
      background: #252525;
    }

    .swagger-ui.dark-mode .highlight-code {
      background: #1e1e1e;
    }

    .swagger-ui.dark-mode .microlight {
      background: #1e1e1e;
      color: #d4d4d4;
    }

    .swagger-ui.dark-mode .scheme-container {
      background: #252525;
      border-color: #3a3a3a;
    }

    .swagger-ui.dark-mode .scheme-container .schemes {
      background: transparent;
    }

    .swagger-ui.dark-mode .loading-container {
      background: #1e1e1e;
    }

    .swagger-ui.dark-mode .loading::after {
      border-top-color: #4990e2;
    }

    .swagger-ui.dark-mode .model-box-control,
    .swagger-ui.dark-mode .model-toggle {
      background: transparent;
      color: #4990e2;
    }

    .swagger-ui.dark-mode .model-title {
      color: #ffffff;
    }

    .swagger-ui.dark-mode .model {
      background: #252525;
      color: #d4d4d4;
    }

    .swagger-ui.dark-mode .prop-format {
      color: #999;
    }

    .swagger-ui.dark-mode table thead tr td,
    .swagger-ui.dark-mode table thead tr th {
      background: #2a2a2a;
      color: #ffffff;
      border-color: #3a3a3a;
    }

    .swagger-ui.dark-mode table tbody tr td {
      border-color: #3a3a3a;
      color: #d4d4d4;
    }

    .swagger-ui.dark-mode .response-col_description__inner {
      color: #d4d4d4;
    }

    .swagger-ui.dark-mode .renderedMarkdown p,
    .swagger-ui.dark-mode .renderedMarkdown code,
    .swagger-ui.dark-mode .renderedMarkdown pre {
      color: #d4d4d4;
    }

    .swagger-ui.dark-mode .renderedMarkdown code {
      background: #2a2a2a;
      color: #e1e1e1;
    }

    .swagger-ui.dark-mode .renderedMarkdown pre {
      background: #1e1e1e;
      border-color: #3a3a3a;
    }

    .swagger-ui.dark-mode .auth-wrapper {
      background: #252525;
      border-color: #3a3a3a;
    }

    .swagger-ui.dark-mode .auth-container {
      background: transparent;
    }

    .swagger-ui.dark-mode .auth-btn-wrapper {
      background: transparent;
    }

    .swagger-ui.dark-mode .dialog-ux .modal-ux {
      background: #252525;
    }

    .swagger-ui.dark-mode .dialog-ux .modal-ux-header {
      background: #2a2a2a;
      border-color: #3a3a3a;
    }

    .swagger-ui.dark-mode .dialog-ux .modal-ux-header h3 {
      color: #ffffff;
    }

    .swagger-ui.dark-mode .dialog-ux .modal-ux-content {
      background: #252525;
      color: #e1e1e1;
    }

    .swagger-ui.dark-mode .dialog-ux .modal-ux-content input,
    .swagger-ui.dark-mode .dialog-ux .modal-ux-content textarea {
      background: #1e1e1e;
      border-color: #3a3a3a;
      color: #e1e1e1;
    }

    .swagger-ui.dark-mode .authorization__btn {
      background: #49cc90;
      border-color: #49cc90;
      color: #1e1e1e;
    }

    .swagger-ui.dark-mode .authorization__btn.locked {
      background: #3a3a3a;
      border-color: #3a3a3a;
      color: #e1e1e1;
    }

    /* Icons and SVGs - ensure visibility in both themes */
    .swagger-ui.dark-mode svg {
      fill: #e1e1e1;
    }

    .swagger-ui:not(.dark-mode) svg {
      fill: #3b4151;
    }

    /* Method badges */
    .swagger-ui.dark-mode .opblock.opblock-post .opblock-summary-method {
      background: #49cc90;
    }

    .swagger-ui.dark-mode .opblock.opblock-get .opblock-summary-method {
      background: #61affe;
    }

    .swagger-ui.dark-mode .opblock.opblock-put .opblock-summary-method {
      background: #fca130;
    }

    .swagger-ui.dark-mode .opblock.opblock-delete .opblock-summary-method {
      background: #f93e3e;
    }

    .swagger-ui.dark-mode .opblock.opblock-patch .opblock-summary-method {
      background: #50e3c2;
    }

    /* Labels and badges */
    .swagger-ui.dark-mode .label {
      color: #e1e1e1;
    }

    .swagger-ui:not(.dark-mode) .label {
      color: #3b4151;
    }

    /* Response codes */
    .swagger-ui.dark-mode .response-col_status.response-col_status--success {
      color: #49cc90;
    }

    .swagger-ui:not(.dark-mode) .response-col_status.response-col_status--success {
      color: #49cc90;
    }

    /* Tab buttons */
    .swagger-ui.dark-mode .tab li button {
      color: #b8b8b8;
    }

    .swagger-ui.dark-mode .tab li.active button {
      color: #4990e2;
      border-color: #4990e2;
    }

    .swagger-ui:not(.dark-mode) .tab li button {
      color: #808080;
    }

    .swagger-ui:not(.dark-mode) .tab li.active button {
      color: #4990e2;
      border-color: #4990e2;
    }

    /* Filter input */
    .swagger-ui.dark-mode .filter-container input {
      background: #2a2a2a;
      border-color: #3a3a3a;
      color: #e1e1e1;
    }

    .swagger-ui:not(.dark-mode) .filter-container input {
      background: #ffffff;
      border-color: #d9d9d9;
      color: #3b4151;
    }

    /* Select dropdowns */
    .swagger-ui.dark-mode select {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23e1e1e1' d='M10.293 3.293L6 7.586 1.707 3.293A1 1 0 00.293 4.707l5 5a1 1 0 001.414 0l5-5a1 1 0 10-1.414-1.414z'/%3E%3C/svg%3E");
    }

    .swagger-ui:not(.dark-mode) select {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%233b4151' d='M10.293 3.293L6 7.586 1.707 3.293A1 1 0 00.293 4.707l5 5a1 1 0 001.414 0l5-5a1 1 0 10-1.414-1.414z'/%3E%3C/svg%3E");
    }

    /* Additional fixes for better visibility */
    .swagger-ui.dark-mode .scheme-container select {
      color: #e1e1e1;
    }

    .swagger-ui:not(.dark-mode) .scheme-container select {
      color: #3b4151;
    }

    .swagger-ui.dark-mode .opblock .opblock-summary .opblock-summary-path .string {
      color: #61affe;
    }

    .swagger-ui:not(.dark-mode) .opblock .opblock-summary .opblock-summary-path .string {
      color: #61affe;
    }

    .swagger-ui.dark-mode .opblock .opblock-summary .opblock-summary-description {
      color: #b8b8b8;
    }

    .swagger-ui:not(.dark-mode) .opblock .opblock-summary .opblock-summary-description {
      color: #808080;
    }

    .swagger-ui.dark-mode .opblock-description-wrapper code,
    .swagger-ui.dark-mode .opblock-external-docs code {
      background: #2a2a2a;
      color: #e1e1e1;
    }

    .swagger-ui:not(.dark-mode) .opblock-description-wrapper code,
    .swagger-ui:not(.dark-mode) .opblock-external-docs code {
      background: #f0f0f0;
      color: #3b4151;
    }

    .swagger-ui.dark-mode .parameter__extension,
    .swagger-ui.dark-mode .parameter__in {
      color: #999;
    }

    .swagger-ui:not(.dark-mode) .parameter__extension,
    .swagger-ui:not(.dark-mode) .parameter__in {
      color: #808080;
    }

    .swagger-ui.dark-mode .response-col_description__inner code {
      background: #2a2a2a;
      color: #e1e1e1;
    }

    .swagger-ui:not(.dark-mode) .response-col_description__inner code {
      background: #f0f0f0;
      color: #3b4151;
    }

    .swagger-ui.dark-mode .prop-name {
      color: #7fdbff;
    }

    .swagger-ui:not(.dark-mode) .prop-name {
      color: #3b4151;
    }

    .swagger-ui.dark-mode .prop-type {
      color: #61affe;
    }

    .swagger-ui:not(.dark-mode) .prop-type {
      color: #3b4151;
    }
  `,
  // swagger-ui-express uses `customJs` (not customJsUrl)
  customJs: '/api/docs/theme-toggle.js',
  customSiteTitle: 'QAIT API Documentation',
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    filter: true,
    tryItOutEnabled: true,
  },
}));

// Swagger JSON endpoint
app.get('/api/docs.json', (req: express.Request, res: express.Response) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Swagger theme toggle JavaScript endpoint
app.get('/api/docs/theme-toggle.js', (req: express.Request, res: express.Response) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    (function() {
      // Load saved theme preference
      const savedTheme = localStorage.getItem('swagger-theme') || 'light';
      let swaggerUI = document.querySelector('.swagger-ui');

      // Apply saved theme on load
      function applyTheme(isDark) {
        if (!swaggerUI) {
          swaggerUI = document.querySelector('.swagger-ui');
        }
        if (swaggerUI) {
          if (isDark) {
            swaggerUI.classList.add('dark-mode');
          } else {
            swaggerUI.classList.remove('dark-mode');
          }
        }
      }

      // Apply saved theme immediately if swagger UI is already loaded
      if (swaggerUI) {
        applyTheme(savedTheme === 'dark');
      }

      // Wait for DOM to be ready
      function initThemeToggle() {
        // Check if button already exists
        if (document.getElementById('theme-toggle-btn')) {
          return;
        }

        // Create theme toggle button
        const container = document.createElement('div');
        container.className = 'theme-toggle-container';
        container.innerHTML = \`
          <button id="theme-toggle-btn" class="theme-toggle-btn" aria-label="Toggle theme">
            <svg id="theme-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
            </svg>
            <span id="theme-text">Dark Mode</span>
          </button>
        \`;

        document.body.appendChild(container);

        const btn = document.getElementById('theme-toggle-btn');
        const icon = document.getElementById('theme-icon');
        const text = document.getElementById('theme-text');

        // Update button appearance based on current theme
        function updateButton(isDark) {
          if (!text || !icon) return;

          if (isDark) {
            text.textContent = 'Light Mode';
            icon.innerHTML = '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';
          } else {
            text.textContent = 'Dark Mode';
            icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
          }
        }

        // Get current theme state
        function getCurrentTheme() {
          const ui = document.querySelector('.swagger-ui');
          return ui ? ui.classList.contains('dark-mode') : (savedTheme === 'dark');
        }

        // Initialize button state
        updateButton(getCurrentTheme());

        // Toggle theme on button click
        if (btn) {
          btn.addEventListener('click', function() {
            const isDark = getCurrentTheme();
            const newTheme = !isDark;

            applyTheme(newTheme);
            localStorage.setItem('swagger-theme', newTheme ? 'dark' : 'light');
            updateButton(newTheme);
          });
        }
      }

      // Initialize when DOM is ready
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initThemeToggle);
      } else {
        initThemeToggle();
      }

      // Also try after delays in case Swagger UI loads async
      setTimeout(initThemeToggle, 500);
      setTimeout(initThemeToggle, 1500);
      setTimeout(initThemeToggle, 3000);

      // Observer for when swagger UI is added to DOM
      const observer = new MutationObserver(function(mutations) {
        if (document.querySelector('.swagger-ui') && !document.getElementById('theme-toggle-btn')) {
          initThemeToggle();
          applyTheme(savedTheme === 'dark');
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    })();
  `);
});

// Features documentation (password protected)
import { docsLogin, docsLogout, requireDocsAuth } from '@/middleware/docs-auth.middleware';
import path from 'path';

// Get correct path for static files (works in both dev and production)
const getDocsPath = () => {
  // In production, __dirname points to dist/
  // In development, we need to go up from dist/ to root
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    // In production: dist/ -> root -> docs/features
    return path.join(__dirname, '../../docs/features');
  } else {
    // In development: dist/ -> root -> docs/features (same)
    return path.join(process.cwd(), 'docs/features');
  }
};

const docsPath = getDocsPath();

// Login/logout routes for documentation
app.post('/api/features/login', express.urlencoded({ extended: true }), docsLogin);
app.post('/api/features/logout', docsLogout);

// Serve features documentation with password protection
app.use('/api/features', requireDocsAuth, express.static(docsPath, {
  index: 'index.html',
  extensions: ['html'],
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  },
}));

// Redirect root /api/features to index
app.get('/api/features', requireDocsAuth, (req: express.Request, res: express.Response) => {
  const indexPath = path.join(docsPath, 'index.html');
  res.sendFile(indexPath);
});

// Architecture documentation (password protected)
const getArchitectureDocPath = () => {
  // Use same logic as getDocsPath for consistency
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    // In production: dist/ -> root -> docs/INTELLIGENT_MODE_ARCHITECTURE.html
    return path.join(__dirname, '../../docs/INTELLIGENT_MODE_ARCHITECTURE.html');
  } else {
    // In development: use process.cwd() (works with both compiled and ts-node/tsx)
    return path.join(process.cwd(), 'docs/INTELLIGENT_MODE_ARCHITECTURE.html');
  }
};

app.get('/api/architecture', requireDocsAuth, (req: express.Request, res: express.Response) => {
  const architecturePath = getArchitectureDocPath();

  logger.debug('[SERVER] Serving architecture documentation', {
    path: architecturePath,
    cwd: process.cwd(),
    __dirname: __dirname,
    nodeEnv: process.env.NODE_ENV,
  });

  res.sendFile(architecturePath, (err) => {
    if (err) {
      logger.error('[SERVER] Failed to serve architecture documentation', {
        error: err.message,
        path: architecturePath,
        cwd: process.cwd(),
        __dirname: __dirname,
      });
      res.status(404).json({
        success: false,
        error: 'Architecture documentation not found',
        path: architecturePath,
      });
    }
  });
});

/**
 * @swagger
 * /health/live:
 *   get:
 *     summary: Lightweight liveness probe
 *     description: Always returns 200 when process is running (for Cloud Run startup/liveness probes)
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Process is alive
 */
app.get('/health/live', (req: express.Request, res: express.Response) => {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
  });
});

/**
 * @swagger
 * /api/v1/system/status:
 *   get:
 *     summary: Current system health snapshot
 *     description: |
 *       Returns the in-process system health snapshot maintained by
 *       SystemHealthMonitor. The frontend calls this on app load so the
 *       maintenance banner can render immediately for users who connect after
 *       the outage already started (the WebSocket `system:maintenance` push
 *       only reaches sockets that were already connected when the status
 *       changed).
 *
 *       This endpoint is intentionally PUBLIC (no auth) so unauthenticated
 *       visitors can also see "service is down" instead of a generic 401.
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Current snapshot
 */
app.get(`/api/${env.API_VERSION}/system/status`, (req: express.Request, res: express.Response) => {
  // Same CORS treatment as /health — allow frontend monitoring tools.
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  const snapshot = SystemHealthMonitor.getStatus();
  res.status(200).json({
    success: true,
    data: snapshot,
  });
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check endpoint
 *     description: Health check for services (database, queue)
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: All services are operational
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: healthy
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 services:
 *                   type: object
 *                   properties:
 *                     database:
 *                       type: string
 *                       example: healthy
 *                     queue:
 *                       type: string
 *                       example: healthy
 *       503:
 *         description: One or more services are unavailable
 */
// Health check endpoint
app.get('/health', async (req: express.Request, res: express.Response) => {
  // ✅ FIX: Ensure CORS headers are set for health check (important for frontend monitoring)
  // Only for allowed origins to avoid security issues
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-ID');
  }

  try {
    // Use Promise.allSettled with timeout to handle individual service failures gracefully
    const healthCheckPromise = Promise.allSettled([
      Promise.race([
        testSupabaseConnection(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Database check timeout')), 5000)),
      ]),
      Promise.race([
        testSupabaseAuthHealth(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Auth check timeout')), 5000)),
      ]),
      Promise.race([
        QueueManager.healthCheck(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Queue check timeout')), 10000)),
      ]),
    ]);

    const [dbResult, authResult, queueResult] = await healthCheckPromise;

    // Safely extract results
    const dbHealth = dbResult.status === 'fulfilled' ? dbResult.value : false;
    const authHealth = authResult.status === 'fulfilled'
      ? authResult.value
      : { healthy: false, error: 'Auth check failed' };
    const queueHealth = queueResult.status === 'fulfilled'
      ? queueResult.value
      : {
        status: 'unhealthy' as const,
        error: queueResult.reason instanceof Error ? queueResult.reason.message : String(queueResult.reason),
      };

    // Log failures
    if (dbResult.status === 'rejected') {
      logger.warn('[HEALTH] Database check failed', {
        error: dbResult.reason instanceof Error ? dbResult.reason.message : String(dbResult.reason),
      });
    }
    if (authResult.status === 'rejected') {
      logger.warn('[HEALTH] Auth check failed', {
        error: authResult.reason instanceof Error ? authResult.reason.message : String(authResult.reason),
      });
    }
    if (queueResult.status === 'rejected') {
      logger.warn('[HEALTH] Queue check failed', {
        error: queueResult.reason instanceof Error ? queueResult.reason.message : String(queueResult.reason),
      });
    }

    const isHealthy = dbHealth && authHealth.healthy && queueHealth.status === 'healthy';
    const health = {
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      services: {
        database: dbHealth ? 'healthy' : 'unhealthy',
        auth: authHealth.healthy ? 'healthy' : 'unhealthy',
        authLatency: authHealth.latency ? `${authHealth.latency}ms` : undefined,
        queue: queueHealth.status || 'unhealthy',
      },
      version: process.env.npm_package_version || '1.0.0',
      environment: env.NODE_ENV,
    };

    const statusCode = isHealthy ? 200 : 503;
    res.status(statusCode).json(health);
  } catch (error) {
    logger.error('[HEALTH] Health check failed:', {
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.constructor.name : typeof error,
    });
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed',
    });
  }
});

// API routes — no approval required (auth, onboarding, billing, waitlist)
app.use(`/api/${env.API_VERSION}/auth`, authRoutes);
app.use(`/api/${env.API_VERSION}/workspaces`, workspaceRoutes); // Contains onboarding endpoints
app.use(`/api/${env.API_VERSION}/invites`, invitesRoutes); // Workspace invites accept endpoint
app.use(`/api/${env.API_VERSION}/waitlist`, waitlistRoutes); // Waitlist signup
app.use(`/api/${env.API_VERSION}/investor`, investorRoutes); // Investor report visit tracking
app.use(`/api/${env.API_VERSION}/billing`, stripeRoutes); // Stripe billing endpoints
app.use(`/api/${env.API_VERSION}/stripe`, stripeRoutes); // Stripe webhook endpoint
app.use(`/api/${env.API_VERSION}/notifications`, notificationsRoutes); // User notifications (needed for pending users)
app.use(`/api/${env.API_VERSION}/announcements`, announcementsRoutes); // What's New announcements
app.use(`/api/${env.API_VERSION}/user`, userRoutes); // User profile (needed for pending users)
app.use(`/api/${env.API_VERSION}/support`, supportRoutes); // User issue reports

// API routes — require approved account status (requireAuth sets req.user, requireApproved checks status)
app.use(`/api/${env.API_VERSION}/analytics`, requireAuth, requireApproved, analyticsRoutes);
app.use(`/api/${env.API_VERSION}/dashboard`, requireAuth, requireApproved, dashboardRoutes);
app.use(`/api/${env.API_VERSION}/projects`, requireAuth, requireApproved, projectRoutes);
app.use(`/api/${env.API_VERSION}/mobile`, requireAuth, requireApproved, mobileRoutes);
app.use(`/api/${env.API_VERSION}/manual-test`, requireAuth, requireApproved, manualTestRoutes);
app.use(`/api/${env.API_VERSION}/intelligent-test`, requireAuth, requireApproved, intelligentTestRoutes);
app.use(`/api/${env.API_VERSION}/test-case`, requireAuth, requireApproved, testCaseRoutes);
app.use(`/api/${env.API_VERSION}/test-resource`, requireAuth, requireApproved, testResourceRoutes);
app.use(`/api/${env.API_VERSION}/chat`, requireAuth, requireApproved, chatRoutes);
app.use(`/api/${env.API_VERSION}/chat/feedback`, requireAuth, requireApproved, feedbackRoutes);
app.use(`/api/${env.API_VERSION}/api-test`, requireAuth, requireApproved, apiTestRoutes);
app.use(`/api/${env.API_VERSION}/api-flow-spec`, requireAuth, requireApproved, apiFlowSpecRoutes);
app.use(`/api/${env.API_VERSION}/api-config`, requireAuth, requireApproved, apiConfigRoutes);
// jira: OAuth callback is public (Atlassian redirects with code/state, no Bearer); router applies auth to all other routes
app.use(`/api/${env.API_VERSION}/jira`, jiraRoutes);
// Fallback when reverse proxy strips /api: accept e.g. /v1/jira/callback
app.use(`/${env.API_VERSION}/jira`, jiraRoutes);
app.use(`/api/${env.API_VERSION}/kb/skills`, requireAuth, requireApproved, skillsRoutes);
app.use(`/api/${env.API_VERSION}/kb/patterns`, requireAuth, requireApproved, patternsRoutes);
app.use(`/api/${env.API_VERSION}/kb`, requireAuth, requireApproved, kbRoutes);
app.use(`/api/${env.API_VERSION}/kb`, requireAuth, requireApproved, rulesReloadRoutes);
app.use(`/api/${env.API_VERSION}/admin`, adminTracesRoutes);
app.use(`/api/${env.API_VERSION}/playwright`, requireAuth, requireApproved, playwrightRoutes);
app.use(`/api/${env.API_VERSION}/reports`, requireAuth, requireApproved, reportsRoutes);
app.use(`/api/${env.API_VERSION}/test-visualization`, requireAuth, requireApproved, testVisualizationRoutes);
// Shared report: public endpoint (no auth) — must be registered before auth-protected regression routes
app.get(`/api/${env.API_VERSION}/regression/shared/:shareToken`, sharedReportRateLimiter, getSharedReport);
app.use(`/api/${env.API_VERSION}/regression`, requireAuth, requireApproved, regressionRoutes);
app.use(`/api/${env.API_VERSION}/platforms`, requireAuth, requireApproved, platformsRoutes);
app.use(`/api/${env.API_VERSION}/modules`, requireAuth, requireApproved, modulesRoutes);
app.use(`/api/${env.API_VERSION}/flows`, requireAuth, requireApproved, flowsRoutes);
app.use(`/api/${env.API_VERSION}/schedules`, requireAuth, requireApproved, schedulesRoutes);
app.use(`/api/${env.API_VERSION}/fixtures`, requireAuth, requireApproved, fixturesRoutes);
app.use(`/api/${env.API_VERSION}/regression-plans`, requireAuth, requireApproved, regressionPlansRoutes);
app.use(`/api/${env.API_VERSION}/explorations`, requireAuth, requireApproved, explorationsRoutes);
// git-integrations: no app-level auth so webhook is public; router applies requireAuth+requireApproved to CRUD only
app.use(`/api/${env.API_VERSION}/git-integrations`, gitIntegrationRoutes);
// Fallback when reverse proxy strips /api: accept webhook at /v1/git-integrations/webhook (same handler, no auth on webhook route)
app.use(`/${env.API_VERSION}/git-integrations`, gitIntegrationRoutes);
// integrations: OAuth callbacks are public (no Bearer on redirect); router applies auth to all other routes
app.use(`/api/${env.API_VERSION}/integrations`, integrationsRoutes);
// Fallback when reverse proxy strips /api: accept e.g. /v1/integrations/github/callback (same handlers)
app.use(`/${env.API_VERSION}/integrations`, integrationsRoutes);
app.use(`/api/${env.API_VERSION}/queue`, requireAuth, requireApproved, queueStatusRoutes);
app.use(`/api/${env.API_VERSION}/preview`, requireAuth, requireApproved, previewRoutes);
app.use(`/api/${env.API_VERSION}/saved-test-cases`, requireAuth, requireApproved, savedTestCasesRoutes);
app.use(`/api/${env.API_VERSION}/tests`, requireAuth, requireApproved, testsRoutes);
app.use(`/api/${env.API_VERSION}/allure-import`, requireAuth, requireApproved, allureImportRoutes);
app.use(`/api/${env.API_VERSION}/email-inbox`, emailInboxRoutes);

// Root endpoint
app.get('/', (req: express.Request, res: express.Response) => {
  res.json({
    success: true,
    message: 'QAIT Backend API',
    version: process.env.npm_package_version || '1.0.0',
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      auth: `/api/${env.API_VERSION}/auth`,
      workspaces: `/api/${env.API_VERSION}/workspaces`,
      projects: `/api/${env.API_VERSION}/projects`,
      manualTest: `/api/${env.API_VERSION}/manual-test`,
      chat: `/api/${env.API_VERSION}/chat`,
      apiTest: `/api/${env.API_VERSION}/api-test`,
      jira: `/api/${env.API_VERSION}/jira`,
      kb: `/api/${env.API_VERSION}/kb`,
      playwright: `/api/${env.API_VERSION}/playwright`,
      testVisualization: `/api/${env.API_VERSION}/test-visualization`,
      notifications: `/api/${env.API_VERSION}/notifications`,
      docs: '/api/docs',
      docsJson: '/api/docs.json',
      architecture: '/api/architecture',
    },
  });
});

// 404 handler
app.use(notFoundHandler);

// Error handler
app.use(errorHandler);

// Wire resource adapters into the registry once per process. Safe to call
// before the server starts listening — it's a pure in-memory operation.
registerBuiltinResourceAdapters();

// Start server
const startServer = async () => {
  let server: ReturnType<typeof app.listen> | null = null;
  let isShuttingDown = false;

  // ✅ FIX: Middleware to handle requests during deployment/shutdown
  // Returns 503 Service Unavailable with CORS headers when server is shutting down
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (isShuttingDown) {
      // Server is shutting down - return 503 with CORS headers
      const origin = req.headers.origin;
      if (origin && isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-ID, X-Admin-Key');
      }
      res.status(503).json({
        success: false,
        error: 'Service temporarily unavailable',
        code: 'SERVICE_UNAVAILABLE',
        details: 'The service is currently being updated. Please try again in a few moments.',
        timestamp: new Date().toISOString(),
      });
      return;
    }
    next();
  });

  try {
    // Validate PORT
    if (!env.PORT || !Number.isFinite(env.PORT) || env.PORT < 1 || env.PORT > 65535) {
      logger.error(`Invalid PORT: ${env.PORT}. Must be between 1 and 65535`);
      process.exit(1);
    }

    // Initialize global KB (load into memory)
    try {
      const { initializeGlobalKB } = await import('@/services/kb/localKB.service');
      await initializeGlobalKB();
      logger.info('✓ Global KB initialized successfully');
    } catch (kbError) {
      logger.warn('[SERVER] Failed to initialize global KB, continuing without it', {
        error: kbError instanceof Error ? kbError.message : String(kbError),
      });
    }

    // Initialize Rules Cache (load AI response rules into memory)
    try {
      const { RulesCacheService } = await import('@/services/kb/rules-cache.service');
      await RulesCacheService.init();
      logger.info('✓ Rules cache initialized successfully');
    } catch (rulesCacheError) {
      logger.warn('[SERVER] Failed to initialize rules cache, continuing without it', {
        error: rulesCacheError instanceof Error ? rulesCacheError.message : String(rulesCacheError),
      });
    }

    // Register all skills from manifest (Jira, GitHub, Notion, etc.)
    try {
      const { registerAllSkills } = await import('@/services/skills');
      await registerAllSkills();
    } catch (skillsError) {
      logger.warn('[SERVER] Failed to register skills, continuing without them', {
        error: skillsError instanceof Error ? skillsError.message : String(skillsError),
      });
    }

    // Test database connection with timeout
    try {
      const dbCheckPromise = testSupabaseConnection();
      const dbTimeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Database connection timeout')), 10000)
      );

      const dbConnected = await Promise.race([dbCheckPromise, dbTimeoutPromise]);
      if (!dbConnected) {
        if (env.NODE_ENV === 'production') {
          logger.warn('[SERVER] Database connection unavailable on startup. Running in limited mode.');
        } else {
          logger.error('[SERVER] Failed to connect to database. Exiting...');
          process.exit(1);
        }
      } else {
        logger.info('✓ Database connection verified');
      }
    } catch (dbError) {
      if (env.NODE_ENV === 'production') {
        logger.warn('[SERVER] Database connection failed on startup. Running in limited mode.', {
          error: dbError instanceof Error ? dbError.message : String(dbError),
        });
      } else {
        logger.error('[SERVER] Database connection failed', {
          error: dbError instanceof Error ? dbError.message : String(dbError),
        });
        process.exit(1);
      }
    }

    // Test queue connection (non-blocking in development)
    try {
      const queueCheckPromise = QueueManager.healthCheck();
      const queueTimeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Queue connection timeout')), 10000)
      );

      const queueHealth = await Promise.race([queueCheckPromise, queueTimeoutPromise]);
      if (queueHealth.status !== 'healthy') {
        if (env.NODE_ENV === 'production') {
          logger.warn('[SERVER] Queue service is unhealthy on startup. Running in limited mode.');
        } else {
          logger.warn('[SERVER] ⚠️  Queue service is unavailable. Running in limited mode.');
          logger.warn('[SERVER] 💡 To enable full functionality, start Redis: redis-server');
        }
      } else {
        logger.info('✓ Queue connection verified');
      }
    } catch (queueError) {
      logger.warn('[SERVER] Queue health check failed on startup, continuing in limited mode', {
        error: queueError instanceof Error ? queueError.message : String(queueError),
      });
    }

    // Start HTTP server
    try {
      server = app.listen(env.PORT, async () => {
        logger.info(`QAIT Backend started | port=${env.PORT} env=${env.NODE_ENV}`);

        // V21: Start system health monitor (polls Supabase, broadcasts maintenance
        // banner to all connected clients on outage). Independent from zombie cleanup
        // and safe to start before any test infrastructure is initialised.
        try {
          SystemHealthMonitor.start();
        } catch (monitorError) {
          logger.error('[SERVER] Failed to start system health monitor', {
            error: formatError(monitorError),
          });
        }

        // Cleanup zombie regression runs from previous server crashes
        try {
          const { RegressionRunService } = await import('@/services/testing/regression/regression-run.service');
          await RegressionRunService.cleanupZombieRuns();

          // Run zombie cleanup every 10 minutes to catch runs stuck during runtime
          setInterval(async () => {
            try {
              await RegressionRunService.cleanupZombieRuns();
            } catch (err) {
              logger.error('[SERVER] Periodic zombie cleanup failed', { error: formatError(err) });
            }
          }, 10 * 60 * 1000);
        } catch (cleanupError) {
          logger.error('[SERVER] Failed to cleanup zombie runs', { error: formatError(cleanupError) });
        }
      });

      /**
       * ✅ FIX: Configure server timeouts to prevent premature connection closure
       * - timeout: 180s (3 minutes) - allows long AI requests to complete
       * - keepAliveTimeout: 65s - longer than typical load balancer timeout (60s)
       * - headersTimeout: 66s - must be > keepAliveTimeout to avoid race conditions
       *
       * Why these values:
       * - OpenAI requests can take 30-60s for large contexts
       * - Load balancers (Nginx, Cloudflare) typically timeout at 60s
       * - We need buffer time for retries and error handling
       */
      server.timeout = 180000; // 3 minutes (default is 120s)
      server.keepAliveTimeout = 65000; // 65 seconds (default is 5s)
      server.headersTimeout = 66000; // 66 seconds (must be > keepAliveTimeout)

      // Handle server errors
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          logger.error(`[SERVER] Port ${env.PORT} is already in use`);
        } else {
          logger.error('[SERVER] HTTP server error:', {
            error: error.message,
            code: error.code,
          });
        }
        process.exit(1);
      });
    } catch (serverError) {
      logger.error('[SERVER] Failed to start HTTP server:', {
        error: serverError instanceof Error ? serverError.message : String(serverError),
      });
      process.exit(1);
    }

    // Initialize WebSocket server
    try {
      const { initializeWebSocket } = await import('@/websocket/core/server');
      if (server) {
        initializeWebSocket(server);

        // Start Redis subscriber for worker events (bridges worker → WebSocket clients)
        try {
          const { webSocketRedisSubscriber } = await import('@/websocket/infrastructure/redis-subscriber');
          await webSocketRedisSubscriber.start();
        } catch (subError) {
          logger.error('[SERVER] Failed to start WebSocket Redis subscriber:', {
            error: subError instanceof Error ? subError.message : String(subError),
          });
          // Continue without subscriber - events from workers will be lost
          if (env.NODE_ENV !== 'development') {
            logger.warn('[SERVER] Running without Redis subscriber - worker events will not reach clients!');
          }
        }

        // Start execution completion emitter Redis subscriber
        // Bridges worker process test completion signals to main process for dependency-aware execution
        try {
          const { executionCompletionEmitter } = await import('@/services/testing/executions/execution-completion-emitter');
          await executionCompletionEmitter.startSubscriber();
        } catch (emitterError) {
          logger.warn('[SERVER] Failed to start execution completion Redis subscriber (dependency coordination may be slow)', {
            error: emitterError instanceof Error ? emitterError.message : String(emitterError),
          });
        }
      }
    } catch (wsError) {
      logger.error('[SERVER] Failed to initialize WebSocket server:', {
        error: wsError instanceof Error ? wsError.message : String(wsError),
      });
      // Keep API alive even if WS init fails; health endpoint will reflect dependency status.
      logger.warn('[SERVER] Continuing without WebSocket subsystem');
    }

    // Graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      // Prevent multiple shutdown attempts
      if (isShuttingDown) {
        logger.warn(`[SERVER] Shutdown already in progress, ignoring ${signal}`);
        return;
      }

      isShuttingDown = true;
      logger.info(`[SERVER] Received ${signal}. Starting graceful shutdown...`);

      const SHUTDOWN_TIMEOUT = 30000; // 30 seconds
      const shutdownTimeout = setTimeout(() => {
        logger.error('[SERVER] Shutdown timeout exceeded, forcing exit');
        process.exit(1);
      }, SHUTDOWN_TIMEOUT);

      try {
        // V21: Stop the system health poll loop early so we don't keep probing
        // Supabase while the rest of the process is tearing down.
        try {
          SystemHealthMonitor.stop();
        } catch { /* non-critical */ }

        // Stop accepting new connections
        if (server) {
          server.close(async () => {
            logger.info('[SERVER] HTTP server closed');

            // Close services in parallel with error handling
            const cleanupResults = await Promise.allSettled([
              // ✅ NEW: Stop Redis subscriber
              (async () => {
                try {
                  const { webSocketRedisSubscriber } = await import('@/websocket/infrastructure/redis-subscriber');
                  await webSocketRedisSubscriber.stop();
                  logger.info('[SERVER] WebSocket Redis subscriber stopped');
                } catch (error) {
                  logger.error('[SERVER] Error stopping Redis subscriber:', {
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              })(),

              // Stop execution completion Redis subscriber
              (async () => {
                try {
                  const { executionCompletionEmitter } = await import('@/services/testing/executions/execution-completion-emitter');
                  await executionCompletionEmitter.stopSubscriber();
                } catch { /* best effort */ }
              })(),

              // Close browser pool
              (async () => {
                try {
                  const { browserPool } = await import('@/agent');
                  await browserPool.closeAll();
                  logger.info('[SERVER] Browser pool closed');
                } catch (error) {
                  logger.error('[SERVER] Error closing browsers:', {
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              })(),

              // ✅ NEW: Close preview sessions (step editor browsers)
              (async () => {
                try {
                  const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
                  await getPreviewSessionService().shutdown();
                  logger.info('[SERVER] Preview sessions closed');
                } catch (error) {
                  logger.error('[SERVER] Error closing preview sessions:', {
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              })(),

              // Close queue connections
              (async () => {
                try {
                  const queuesModule = await import('@/config/infrastructure/queues');
                  await queuesModule.gracefulShutdown();
                  logger.info('[SERVER] Queue connections closed');
                } catch (error) {
                  logger.error('[SERVER] Error during queue shutdown:', {
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              })(),
              // Close WebSocket server
              (async () => {
                try {
                  const { shutdownWebSocket } = await import('@/websocket/core/server');
                  await shutdownWebSocket();
                  logger.info('[SERVER] WebSocket server closed');
                } catch (error) {
                  logger.error('[SERVER] Error closing WebSocket:', {
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              })(),
            ]);

            // Log any failures
            cleanupResults.forEach((result, index) => {
              if (result.status === 'rejected') {
                const serviceNames = ['redis subscriber', 'browser pool', 'preview sessions', 'queues', 'websocket'];
                logger.warn(`[SERVER] Failed to close ${serviceNames[index]}`, {
                  error: result.reason instanceof Error ? result.reason.message : String(result.reason),
                });
              }
            });

            clearTimeout(shutdownTimeout);
            logger.info('[SERVER] Graceful shutdown completed');
            process.exit(0);
          });
        } else {
          clearTimeout(shutdownTimeout);
          logger.warn('[SERVER] Server was not initialized, exiting');
          process.exit(0);
        }
      } catch (error) {
        clearTimeout(shutdownTimeout);
        logger.error('[SERVER] Error during shutdown:', {
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      }
    };

    // Handle shutdown signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Prevent process from exiting on unhandled errors (log only)
    process.on('uncaughtException', (error) => {
      logger.error('[SERVER] Uncaught exception:', {
        error: error.message,
        stack: error.stack,
      });
      // Don't exit immediately - let graceful shutdown handle it
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('[SERVER] Unhandled rejection:', {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
      // Don't exit immediately - let graceful shutdown handle it
    });
  } catch (error) {
    logger.error('[SERVER] Failed to start server:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
};

// Start the server
startServer();

export default app;
