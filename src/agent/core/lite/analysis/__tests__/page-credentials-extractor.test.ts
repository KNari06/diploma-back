/**
 * Tests for Page Credentials Extractor
 */

import type { LiteElement, LiteSnapshot } from '../../lite-types';
import { extractPageCredentials, parseCredentialsFromResponse } from '../page-credentials-extractor';

// Helper to create minimal LiteElement
function createElement(overrides: Partial<LiteElement>): LiteElement {
  return {
    ref: 'el_1',
    role: 'text',
    name: '',
    tag: 'div',
    visible: true,
    ...overrides,
  };
}

function bounds(x: number, y: number, width = 200, height = 30): LiteElement['bounds'] {
  return { x, y, width, height };
}

// Helper to create minimal LiteSnapshot
function createSnapshot(elements: LiteElement[], title = 'Test Page'): LiteSnapshot {
  return {
    url: 'https://example.com/login',
    title,
    elements,
    timestamp: Date.now(),
  };
}

describe('extractPageCredentials', () => {
  describe('pageTextForExtraction feature', () => {
    it('should extract credentials from pageTextForExtraction (PracticeTestAutomation scenario)', () => {
      const pageText = `
Practice Test Automation

Test login

This is a simple Login page. Students can use this page to practice writing simple positive and negative LogIn tests.
Use next credentials to execute Login:
Username: student
Password: Password123

Test case 1: Positive LogIn test
1. Open page
2. Type username student into Username field
3. Type password Password123 into Password field
      `.trim();

      const snapshot: LiteSnapshot = {
        url: 'https://practicetestautomation.com/practice-test-login/',
        title: 'Test Login | Practice Test Automation',
        elements: [
          createElement({
            ref: 'u_input',
            tag: 'input',
            type: 'text',
            name: 'Username',
            bounds: bounds(100, 160),
            htmlId: 'username',
          }),
          createElement({
            ref: 'p_input',
            tag: 'input',
            type: 'password',
            name: 'Password',
            bounds: bounds(100, 210),
            htmlId: 'password',
          }),
        ],
        timestamp: Date.now(),
        pageTextForExtraction: pageText,
      };

      const result = extractPageCredentials(snapshot, 'practice-test-automation');

      expect(result.username).toBe('student');
      expect(result.password).toBe('Password123');
      expect(result.confidence).not.toBe('none');
      expect(['low', 'medium', 'high']).toContain(result.confidence);
    });

    it('should work without pageTextForExtraction (backward compatibility)', () => {
      const snapshot = createSnapshot([
        createElement({
          ref: 'u_input',
          tag: 'input',
          type: 'text',
          name: 'Username',
          bounds: bounds(100, 160),
          autocomplete: 'username',
        }),
        createElement({
          ref: 'p_input',
          tag: 'input',
          type: 'password',
          name: 'Password',
          bounds: bounds(100, 210),
          autocomplete: 'current-password',
        }),
        createElement({
          ref: 'creds_text',
          name: 'Username: admin Password: secret123',
          tag: 'div',
          bounds: bounds(100, 120),
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      expect(result.username).toBe('admin');
      expect(result.password).toBe('secret123');
      expect(result.confidence).toBe('high');
    });
  });

  describe('practicetestautomation.com format', () => {
    it('should extract credentials from "username is student" format', () => {
      const snapshot = createSnapshot([
        // Login form inputs (for proximity)
        createElement({
          ref: 'u_input',
          tag: 'input',
          type: 'text',
          name: 'Username',
          bounds: bounds(100, 140),
          autocomplete: 'username',
        }),
        createElement({
          ref: 'p_input',
          tag: 'input',
          type: 'password',
          name: 'Password',
          bounds: bounds(100, 190),
          autocomplete: 'current-password',
        }),
        createElement({
          ref: 'u_text',
          name: 'Username: student',
          tag: 'p',
          bounds: bounds(100, 100),
        }),
        createElement({
          ref: 'p_text',
          name: 'Password: Password123',
          tag: 'p',
          bounds: bounds(100, 120),
        }),
      ]);

      const result = extractPageCredentials(snapshot, 'test-1');

      expect(result.username).toBe('student');
      expect(result.password).toBe('Password123');
      expect(result.confidence).toBe('high');
    });

    it('should extract from "username is xxx" pattern', () => {
      const snapshot = createSnapshot([
        createElement({
          ref: 'u_input',
          tag: 'input',
          type: 'text',
          name: 'Username',
          bounds: bounds(100, 160),
          autocomplete: 'username',
        }),
        createElement({
          ref: 'p_input',
          tag: 'input',
          type: 'password',
          name: 'Password',
          bounds: bounds(100, 210),
          autocomplete: 'current-password',
        }),
        createElement({
          ref: 'creds_block',
          name: 'Use credentials: username is student, password is Password123',
          tag: 'div',
          bounds: bounds(100, 120),
        }),
      ]);

      const result = extractPageCredentials(snapshot, 'test-2');

      expect(result.username).toBe('student');
      expect(result.password).toBe('Password123');
      expect(result.confidence).toBe('high');
    });
  });

  describe('various credential formats', () => {
    it('should extract from colon format "User: admin"', () => {
      const snapshot = createSnapshot([
        createElement({
          ref: 'u_input',
          tag: 'input',
          type: 'email',
          name: 'Email',
          bounds: bounds(100, 150),
          autocomplete: 'email',
        }),
        createElement({
          ref: 'p_input',
          tag: 'input',
          type: 'password',
          name: 'Password',
          bounds: bounds(100, 200),
          autocomplete: 'current-password',
        }),
        createElement({
          ref: 'creds_text',
          name: 'Login credentials - User: admin Password: secret123',
          tag: 'span',
          bounds: bounds(100, 120),
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      expect(result.username).toBe('admin');
      expect(result.password).toBe('secret123');
      expect(result.confidence).toBe('high');
    });

    it('should extract from equals format "username = test"', () => {
      const snapshot = createSnapshot([
        createElement({
          ref: 'u_input',
          tag: 'input',
          type: 'text',
          name: 'Login',
          bounds: bounds(100, 150),
          autocomplete: 'username',
        }),
        createElement({
          ref: 'p_input',
          tag: 'input',
          type: 'password',
          name: 'Password',
          bounds: bounds(100, 200),
          autocomplete: 'current-password',
        }),
        createElement({
          ref: 'creds_text',
          name: 'Demo account: username = demo_user, password = demo_pass',
          tag: 'div',
          bounds: bounds(100, 120),
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      expect(result.username).toBe('demo_user');
      expect(result.password).toBe('demo_pass');
      expect(result.confidence).toBe('high');
    });

    it('should extract email as username', () => {
      const snapshot = createSnapshot([
        createElement({
          ref: 'u_input',
          tag: 'input',
          type: 'email',
          name: 'Email',
          bounds: bounds(100, 160),
          autocomplete: 'email',
        }),
        createElement({
          ref: 'p_input',
          tag: 'input',
          type: 'password',
          name: 'Password',
          bounds: bounds(100, 210),
          autocomplete: 'current-password',
        }),
        createElement({
          ref: 'u_text',
          name: 'Email: test@example.com',
          tag: 'p',
          bounds: bounds(100, 110),
        }),
        createElement({
          ref: 'p_text',
          name: 'Password: MyPassword!',
          tag: 'p',
          bounds: bounds(100, 130),
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      expect(result.username).toBe('test@example.com');
      expect(result.password).toBe('MyPassword!');
      expect(result.confidence).toBe('high');
    });

    it('should handle quoted values', () => {
      const snapshot = createSnapshot([
        createElement({
          ref: 'u_input',
          tag: 'input',
          type: 'text',
          name: 'Username',
          bounds: bounds(100, 160),
          autocomplete: 'username',
        }),
        createElement({
          ref: 'p_input',
          tag: 'input',
          type: 'password',
          name: 'Password',
          bounds: bounds(100, 210),
          autocomplete: 'current-password',
        }),
        createElement({
          ref: 'u_text',
          name: 'username: "admin_user"',
          tag: 'div',
          bounds: bounds(100, 110),
        }),
        createElement({
          ref: 'p_text',
          name: "password: 'SecretPass'",
          tag: 'div',
          bounds: bounds(100, 130),
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      expect(result.username).toBe('admin_user');
      expect(result.password).toBe('SecretPass');
      expect(result.confidence).toBe('high');
    });

    it('should prefer nearby credential text over footer mention', () => {
      const snapshot = createSnapshot([
        createElement({
          ref: 'u_input',
          tag: 'input',
          type: 'text',
          name: 'Username',
          bounds: bounds(100, 160),
          autocomplete: 'username',
        }),
        createElement({
          ref: 'p_input',
          tag: 'input',
          type: 'password',
          name: 'Password',
          bounds: bounds(100, 210),
          autocomplete: 'current-password',
        }),
        // Good nearby block
        createElement({
          ref: 'nearby_block',
          name: 'Username: student Password: Password123',
          tag: 'div',
          bounds: bounds(120, 120),
        }),
        // Bad footer block far away
        createElement({
          ref: 'footer_block',
          name: 'username: footer_user password: footer_pass',
          tag: 'div',
          bounds: bounds(20, 900),
          context: 'inside: Footer',
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      expect(result.username).toBe('student');
      expect(result.password).toBe('Password123');
      expect(result.confidence).toBe('high');
    });

    it('should extract username from placeholder demo marker near username input', () => {
      const snapshot = createSnapshot([
        createElement({
          ref: 'u_input',
          tag: 'input',
          type: 'text',
          name: 'Username',
          bounds: bounds(100, 160),
          autocomplete: 'username',
          placeholder: 'Demo: student',
        }),
        createElement({
          ref: 'p_input',
          tag: 'input',
          type: 'password',
          name: 'Password',
          bounds: bounds(100, 210),
          autocomplete: 'current-password',
        }),
        createElement({
          ref: 'p_text',
          name: 'Password: Password123',
          tag: 'p',
          bounds: bounds(100, 120),
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      expect(result.username).toBe('student');
      expect(result.password).toBe('Password123');
      expect(result.confidence).toBe('high');
    });

    it('should boost extraction from code/pre tags', () => {
      const snapshot = createSnapshot([
        createElement({
          ref: 'u_input',
          tag: 'input',
          type: 'text',
          name: 'Username',
          bounds: bounds(100, 160),
          autocomplete: 'username',
        }),
        createElement({
          ref: 'p_input',
          tag: 'input',
          type: 'password',
          name: 'Password',
          bounds: bounds(100, 210),
          autocomplete: 'current-password',
        }),
        createElement({
          ref: 'code_block',
          name: 'username: coder password: CodePass123',
          tag: 'code',
          bounds: bounds(400, 120),
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      expect(result.username).toBe('coder');
      expect(result.password).toBe('CodePass123');
      // With pre/code boost + full match it should not be 'none'
      expect(['medium', 'high']).toContain(result.confidence);
    });
  });

  describe('partial extraction', () => {
    it('should return medium confidence when only password found', () => {
      const snapshot = createSnapshot([
        createElement({
          ref: 'p_input',
          tag: 'input',
          type: 'password',
          name: 'Password',
          bounds: bounds(100, 200),
          autocomplete: 'current-password',
        }),
        createElement({
          ref: 'p_text',
          name: 'Default password is: test123',
          tag: 'p',
          bounds: bounds(100, 120),
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      expect(result.username).toBeUndefined();
      expect(result.password).toBe('test123');
      expect(result.confidence).toBe('medium');
    });

    it('should return low confidence when only username found', () => {
      const snapshot = createSnapshot([
        createElement({
          ref: 'u_input',
          tag: 'input',
          type: 'text',
          name: 'Username',
          bounds: bounds(100, 160),
          autocomplete: 'username',
        }),
        createElement({
          ref: 'u_text',
          name: 'Login with username: testuser',
          tag: 'p',
          bounds: bounds(100, 120),
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      expect(result.username).toBe('testuser');
      expect(result.password).toBeUndefined();
      expect(result.confidence).toBe('low');
    });
  });

  describe('no credentials', () => {
    it('should return none confidence when no credentials found', () => {
      const snapshot = createSnapshot([
        createElement({
          name: 'Welcome to our website',
          tag: 'h1',
        }),
        createElement({
          name: 'Please log in to continue',
          tag: 'p',
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      expect(result.username).toBeUndefined();
      expect(result.password).toBeUndefined();
      expect(result.confidence).toBe('none');
    });

    it('should skip input elements', () => {
      const snapshot = createSnapshot([
        createElement({
          name: 'username',
          tag: 'input',
          type: 'text',
        }),
        createElement({
          name: 'password',
          tag: 'input',
          type: 'password',
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      expect(result.confidence).toBe('none');
    });

    it('should skip invisible elements', () => {
      const snapshot = createSnapshot([
        createElement({
          name: 'username: hidden_user, password: hidden_pass',
          tag: 'div',
          visible: false,
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      expect(result.confidence).toBe('none');
    });
  });

  describe('validation guards', () => {
    it('should extract only first word when text has spaces', () => {
      const snapshot = createSnapshot([
        createElement({
          ref: 'u_input',
          tag: 'input',
          type: 'text',
          name: 'Username',
          bounds: bounds(100, 160),
          autocomplete: 'username',
        }),
        createElement({
          ref: 'p_input',
          tag: 'input',
          type: 'password',
          name: 'Password',
          bounds: bounds(100, 210),
          autocomplete: 'current-password',
        }),
        createElement({
          ref: 'creds_text',
          name: 'Username: invalid user name Password: invalid pass word',
          tag: 'div',
          bounds: bounds(100, 120),
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      // Regex patterns stop at spaces, so extracts first word only
      expect(result.username).toBe('invalid');
      expect(result.password).toBe('invalid');
      expect(result.confidence).not.toBe('none');
    });

    it('should cap extracted credential length', () => {
      const longValue = 'a'.repeat(150);
      const snapshot = createSnapshot([
        createElement({
          ref: 'p_input',
          tag: 'input',
          type: 'password',
          name: 'Password',
          bounds: bounds(100, 210),
          autocomplete: 'current-password',
        }),
        createElement({
          ref: 'p_text',
          name: `Password: ${longValue}`,
          tag: 'div',
          bounds: bounds(100, 120),
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      // Pattern limits to 50 chars, then cleanCredentialValue caps at 100
      expect(result.password).toBeDefined();
      expect(result.password!.length).toBeLessThanOrEqual(100);
    });

    it('should reject URL-like credentials', () => {
      const snapshot = createSnapshot([
        createElement({
          ref: 'u_input',
          tag: 'input',
          type: 'text',
          name: 'Username',
          bounds: bounds(100, 160),
          autocomplete: 'username',
        }),
        createElement({
          ref: 'u_text',
          name: 'Username: http://example.com',
          tag: 'div',
          bounds: bounds(100, 120),
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      // Pattern extracts "http" which then gets rejected by guard
      expect(result.username).toBeUndefined();
      expect(result.confidence).toBe('none');
    });

    it('should reject www. prefix credentials', () => {
      const snapshot = createSnapshot([
        createElement({
          ref: 'p_input',
          tag: 'input',
          type: 'password',
          name: 'Password',
          bounds: bounds(100, 210),
          autocomplete: 'current-password',
        }),
        createElement({
          ref: 'p_text',
          name: 'Password: www.example',
          tag: 'div',
          bounds: bounds(100, 120),
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      // Should reject www. prefix
      expect(result.password).toBeUndefined();
      expect(result.confidence).toBe('none');
    });
  });

  describe('edge cases', () => {
    it('should handle empty snapshot', () => {
      const snapshot = createSnapshot([]);

      const result = extractPageCredentials(snapshot);

      expect(result.confidence).toBe('none');
    });

    it('should cap credential length', () => {
      const longValue = 'a'.repeat(200);
      const snapshot = createSnapshot([
        createElement({
          name: `username: ${longValue}`,
          tag: 'div',
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      expect(result.username?.length).toBeLessThanOrEqual(100);
    });

    it('should remove trailing punctuation from username but keep ! in password', () => {
      const snapshot = createSnapshot([
        createElement({
          name: 'Username: testuser.',
          tag: 'p',
        }),
        createElement({
          name: 'Password: pass123!',
          tag: 'p',
        }),
      ]);

      const result = extractPageCredentials(snapshot);

      expect(result.username).toBe('testuser');
      // Note: ! at end of password is kept as it could be part of password
      expect(result.password).toBe('pass123!');
    });
  });
});

describe('parseCredentialsFromResponse', () => {
  describe('structured format', () => {
    it('should parse "username: x, password: y" format', () => {
      const result = parseCredentialsFromResponse('username: admin, password: secret123');

      expect(result).toEqual({ username: 'admin', password: 'secret123' });
    });

    it('should parse "user is x password is y" format', () => {
      const result = parseCredentialsFromResponse('user is testuser password is testpass');

      expect(result).toEqual({ username: 'testuser', password: 'testpass' });
    });
  });

  describe('simple split formats', () => {
    it('should parse "user / pass" format', () => {
      const result = parseCredentialsFromResponse('admin / secretpass');

      expect(result).toEqual({ username: 'admin', password: 'secretpass' });
    });

    it('should parse "user, pass" format', () => {
      const result = parseCredentialsFromResponse('admin, secretpass');

      expect(result).toEqual({ username: 'admin', password: 'secretpass' });
    });

    it('should parse "user pass" (two words) format', () => {
      const result = parseCredentialsFromResponse('myuser mypass');

      expect(result).toEqual({ username: 'myuser', password: 'mypass' });
    });
  });

  describe('invalid input', () => {
    it('should return null for empty string', () => {
      expect(parseCredentialsFromResponse('')).toBeNull();
    });

    it('should return null for whitespace only', () => {
      expect(parseCredentialsFromResponse('   ')).toBeNull();
    });

    it('should return null for very short input (1 char)', () => {
      expect(parseCredentialsFromResponse('a')).toBeNull();
    });
  });

  describe('partial/single value input', () => {
    it('should treat single word as username by default', () => {
      const result = parseCredentialsFromResponse('adminuser');

      expect(result).toEqual({ username: 'adminuser' });
    });

    it('should treat single word with special chars as password (heuristic)', () => {
      const result = parseCredentialsFromResponse('Pass123!');

      expect(result).toEqual({ password: 'Pass123!' });
    });

    it('should use expectingField=username hint', () => {
      const result = parseCredentialsFromResponse('johndoe', 'username');

      expect(result).toEqual({ username: 'johndoe' });
    });

    it('should use expectingField=password hint', () => {
      const result = parseCredentialsFromResponse('mypassword', 'password');

      expect(result).toEqual({ password: 'mypassword' });
    });

    it('should return partial when only username extracted from text', () => {
      const result = parseCredentialsFromResponse('username: testadmin');

      expect(result).toEqual({ username: 'testadmin' });
    });

    it('should return partial when only password extracted from text', () => {
      const result = parseCredentialsFromResponse('password: secret!123');

      expect(result).toEqual({ password: 'secret!123' });
    });
  });
});
