/**
 * Documentation Authentication Middleware
 * Protects documentation routes with password
 */

import { logger } from '@/utils/core/logger';
import { NextFunction, Request, Response } from 'express';

/**
 * Get documentation password from environment
 * Falls back to default password if not set
 */
const getDocsPassword = (): string => {
  return process.env.DOCS_PASSWORD || 'qait-docs-2024';
};

/**
 * Validate and sanitize redirect path to prevent open redirect attacks
 */
const validateRedirectPath = (path: string): string | null => {
  if (!path || typeof path !== 'string') {
    return null;
  }

  // Only allow paths starting with /api/features or /api/architecture
  const allowedPrefixes = ['/api/features', '/api/architecture'];
  const normalizedPath = path.split('?')[0]; // Remove query params for validation

  if (!allowedPrefixes.some(prefix => normalizedPath.startsWith(prefix))) {
    return null;
  }

  // Check for dangerous characters
  if (/[<>"']/.test(path)) {
    return null;
  }

  return path;
};

/**
 * Escape HTML to prevent XSS attacks
 */
const escapeHtml = (unsafe: string): string => {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

/**
 * Middleware to check if user is authenticated for documentation
 */
export const requireDocsAuth = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Check if already authenticated via session (if session exists)
  if ((req as any).session?.docsAuthenticated) {
    return next();
  }

  // Check if authenticated via cookie (parse manually if cookie-parser not available)
  const cookies = req.headers.cookie || '';
  // Parse cookies manually
  const cookieMatch = cookies.match(/docs_authenticated=([^;]+)/);
  if (cookieMatch && cookieMatch[1] === 'true') {
    logger.debug('[DOCS_AUTH] Authenticated via cookie', { ip: req.ip });
    return next();
  }

  // Check for password in query or body (for API access)
  const providedPassword = req.query.password as string || req.body.password;
  const correctPassword = getDocsPassword();

  // Trim passwords to handle whitespace issues
  const trimmedProvidedPassword = providedPassword?.trim();
  const trimmedCorrectPassword = correctPassword.trim();

  // Debug logging for password comparison (only in development)
  if (process.env.NODE_ENV === 'development' && trimmedProvidedPassword) {
    logger.debug('[DOCS_AUTH] Password comparison', {
      providedLength: trimmedProvidedPassword.length,
      correctLength: trimmedCorrectPassword.length,
      match: trimmedProvidedPassword === trimmedCorrectPassword,
      providedBytes: Buffer.from(trimmedProvidedPassword).toString('hex'),
      correctBytes: Buffer.from(trimmedCorrectPassword).toString('hex'),
    });
  }

  if (trimmedProvidedPassword && trimmedProvidedPassword === trimmedCorrectPassword) {
    // Set session (if session middleware is configured)
    if ((req as any).session) {
      (req as any).session.docsAuthenticated = true;
    }
    // Also set cookie for authentication (works even without session middleware)
    res.cookie('docs_authenticated', 'true', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });
    return next();
  }

  // If it's an API request (JSON), return 401
  if (req.headers.accept?.includes('application/json')) {
    res.status(401).json({
      success: false,
      error: 'Unauthorized: Documentation password required',
      message: 'Provide password via ?password=xxx or authenticate via /api/features/login',
    });
    return;
  }

  // Get redirect path from request and validate it
  const rawRedirectPath = req.originalUrl || req.path;
  const redirectPath = validateRedirectPath(rawRedirectPath) || '/api/features';
  const safeRedirectPath = escapeHtml(redirectPath);

  // Otherwise, show login page
  res.status(401).send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Documentation Access</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        .login-container {
            background: white;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            max-width: 400px;
            width: 100%;
        }
        h1 {
            margin: 0 0 10px 0;
            color: #333;
            font-size: 24px;
        }
        p {
            color: #666;
            margin: 0 0 30px 0;
            font-size: 14px;
        }
        .error {
            background: #fee;
            color: #c33;
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 20px;
            font-size: 14px;
            display: none;
        }
        .error.show {
            display: block;
        }
        input[type="password"] {
            width: 100%;
            padding: 12px;
            border: 2px solid #e0e0e0;
            border-radius: 6px;
            font-size: 16px;
            box-sizing: border-box;
            margin-bottom: 20px;
        }
        input[type="password"]:focus {
            outline: none;
            border-color: #667eea;
        }
        button {
            width: 100%;
            padding: 12px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.3s;
        }
        button:hover {
            background: #5568d3;
        }
        button:disabled {
            background: #ccc;
            cursor: not-allowed;
        }
        .info {
            margin-top: 20px;
            padding: 12px;
            background: #f0f0f0;
            border-radius: 6px;
            font-size: 12px;
            color: #666;
        }
    </style>
</head>
<body>
    <div class="login-container">
        <h1>🔐 Documentation Access</h1>
        <p>Enter password to access internal documentation</p>
        <div class="error" id="error"></div>
        <form id="loginForm" method="POST" action="/api/features/login">
            <input type="hidden" name="redirect" value="${safeRedirectPath}" />
            <input
                type="password"
                name="password"
                placeholder="Enter password"
                required
                autofocus
                id="passwordInput"
            />
            <button type="submit" id="submitBtn">Access Documentation</button>
        </form>
        <div class="info">
            <strong>Note:</strong> This documentation contains internal system information. Access is restricted.
        </div>
    </div>
    <script>
        const form = document.getElementById('loginForm');
        const error = document.getElementById('error');
        const passwordInput = document.getElementById('passwordInput');
        const submitBtn = document.getElementById('submitBtn');

        // Check for error in URL
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('error') === 'invalid') {
            error.textContent = 'Invalid password. Please try again.';
            error.classList.add('show');
        }

        form.addEventListener('submit', (e) => {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Checking...';
        });

        passwordInput.addEventListener('input', () => {
            error.classList.remove('show');
        });
    </script>
</body>
</html>
  `);
};

/**
 * Login endpoint for documentation
 */
export const docsLogin = (req: Request, res: Response): void => {
  const { password, redirect } = req.body;
  const correctPassword = getDocsPassword();

  // Log login attempt (always log for debugging)
  logger.info('[DOCS_AUTH] Login attempt', {
    hasPassword: !!password,
    passwordLength: password?.length,
    correctPasswordLength: correctPassword.length,
    redirect,
    nodeEnv: process.env.NODE_ENV,
  });

  // Validate redirect path to prevent open redirect attacks
  const rawRedirectPath = redirect || '/api/features';
  const redirectPath = validateRedirectPath(rawRedirectPath) || '/api/features';
  const errorPath = redirectPath.includes('?')
    ? `${redirectPath}&error=invalid`
    : `${redirectPath}?error=invalid`;

  if (!password) {
    logger.warn('[DOCS_AUTH] No password provided', {
      ip: req.ip,
      redirectPath,
    });
    res.redirect(errorPath);
    return;
  }

  // Trim password to handle whitespace issues
  const trimmedPassword = password.trim();
  const trimmedCorrectPassword = correctPassword.trim();

  // Log password comparison for debugging
  logger.info('[DOCS_AUTH] Password comparison', {
    providedLength: trimmedPassword.length,
    correctLength: trimmedCorrectPassword.length,
    match: trimmedPassword === trimmedCorrectPassword,
  });

  if (trimmedPassword === trimmedCorrectPassword) {
    // Set session (if session middleware is configured)
    if ((req as any).session) {
      (req as any).session.docsAuthenticated = true;
    }

    // Set cookie for authentication (manually set header since cookie-parser not available)
    const cookieOptions = [
      'docs_authenticated=true',
      'HttpOnly',
      process.env.NODE_ENV === 'production' ? 'Secure' : '',
      'SameSite=Lax',
      `Max-Age=${24 * 60 * 60}`, // 24 hours
      'Path=/',
    ].filter(Boolean).join('; ');
    res.setHeader('Set-Cookie', cookieOptions);

    logger.info('[DOCS_AUTH] Documentation access granted', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      redirectPath,
    });

    // Redirect to requested documentation (validated)
    // Add password to query for immediate access (cookie will work on next request)
    const redirectUrl = redirectPath.includes('?')
      ? `${redirectPath}&password=${encodeURIComponent(trimmedCorrectPassword)}`
      : `${redirectPath}?password=${encodeURIComponent(trimmedCorrectPassword)}`;
    res.redirect(redirectUrl);
  } else {
    logger.warn('[DOCS_AUTH] Invalid password attempt', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      redirectPath,
    });

    res.redirect(errorPath);
  }
};

/**
 * Logout endpoint for documentation
 */
export const docsLogout = (req: Request, res: Response): void => {
  if ((req as any).session) {
    (req as any).session.docsAuthenticated = false;
    delete (req as any).session.docsAuthenticated;
  }

  logger.info('[DOCS_AUTH] Documentation access revoked', {
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  // Validate redirect path to prevent open redirect attacks
  // Only allow query parameter, not referer (referer can be from external domain)
  const rawRedirectPath = (req.query.redirect as string) || '/api/features';
  const redirectPath = validateRedirectPath(rawRedirectPath) || '/api/features';
  res.redirect(redirectPath);
};
