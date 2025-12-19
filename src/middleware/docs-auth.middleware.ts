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

  // Check for password in query or body (for API access)
  const providedPassword = req.query.password as string || req.body.password;
  const correctPassword = getDocsPassword();

  if (providedPassword && providedPassword === correctPassword) {
    // Set session (if session middleware is configured)
    if ((req as any).session) {
      (req as any).session.docsAuthenticated = true;
    }
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
  const { password } = req.body;
  const correctPassword = getDocsPassword();

  if (!password) {
    res.redirect('/api/features?error=invalid');
    return;
  }

  if (password === correctPassword) {
    // Set session (if session middleware is configured)
    if ((req as any).session) {
      (req as any).session.docsAuthenticated = true;
    }

    logger.info('[DOCS_AUTH] Documentation access granted', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Redirect to documentation
    res.redirect('/api/features');
  } else {
    logger.warn('[DOCS_AUTH] Invalid password attempt', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.redirect('/api/features?error=invalid');
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

  res.redirect('/api/features');
};
