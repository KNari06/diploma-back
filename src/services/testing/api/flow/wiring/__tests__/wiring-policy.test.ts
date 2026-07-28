import {
  isAuthTokenVar,
  isAuthOrAuthorizationVar,
  isAuthCredentialVar,
  isUserProvidedVar,
  isAuthTokenSuffix,
  realmPrefixOf,
  isAuthEstablishPath,
  toSnakeCase,
  singularize,
  lastPathSegment,
  isReferenceIdField,
  isSnakeIdVar,
  isVerifyStep,
  isSendStep,
  isSessionTeardown,
} from '../wiring-policy';

describe('wiring-policy predicates', () => {
  describe('auth-var sets (divergence preserved from former call sites)', () => {
    it('base set matches tokens but NOT authorization / api_key', () => {
      for (const n of ['auth_token', 'access_token', 'jwt', 'bearer_token', 'session_token', 'token']) {
        expect(isAuthTokenVar(n)).toBe(true);
      }
      expect(isAuthTokenVar('authorization')).toBe(false);
      expect(isAuthTokenVar('api_key')).toBe(false);
      expect(isAuthTokenVar('admin_token')).toBe(false); // exact-match, not suffix
    });

    it('base+authorization set adds only authorization', () => {
      expect(isAuthOrAuthorizationVar('authorization')).toBe(true);
      expect(isAuthOrAuthorizationVar('token')).toBe(true);
      expect(isAuthOrAuthorizationVar('api_key')).toBe(false);
    });

    it('credential set adds authorization AND api_key', () => {
      expect(isAuthCredentialVar('authorization')).toBe(true);
      expect(isAuthCredentialVar('api_key')).toBe(true);
      expect(isAuthCredentialVar('country_id')).toBe(false);
    });

    it('user-provided set includes oauth creds and base_url', () => {
      for (const n of ['oauth_client_id', 'oauth_client_secret', 'base_url', 'api_key', 'token']) {
        expect(isUserProvidedVar(n)).toBe(true);
      }
      expect(isUserProvidedVar('country_id')).toBe(false);
    });

    it('suffix matcher (scorer) catches per-realm tokens the exact sets miss', () => {
      expect(isAuthTokenSuffix('admin_token')).toBe(true);
      expect(isAuthTokenSuffix('user_jwt')).toBe(true);
      expect(isAuthTokenSuffix('token')).toBe(true);
      expect(isAuthTokenSuffix('country_id')).toBe(false);
      // The exact-name set does NOT match admin_token — this is the intended gap.
      expect(isAuthTokenVar('admin_token')).toBe(false);
    });
  });

  describe('realmPrefixOf', () => {
    it('returns the prefix before the first auth segment', () => {
      expect(realmPrefixOf('/api/v1/admin/auth/login')).toBe('/api/v1/admin');
      expect(realmPrefixOf('/api/v1/auth/register')).toBe('/api/v1');
    });
    it('returns empty string when there is no auth segment', () => {
      expect(realmPrefixOf('/api/v1/users')).toBe('');
    });
  });

  describe('isAuthEstablishPath', () => {
    it('is true for session-establishing endpoints', () => {
      for (const p of ['/auth/login', '/admin/auth/login', '/auth/otp/verify', '/auth/refresh', '/auth/register']) {
        expect(isAuthEstablishPath(p)).toBe(true);
      }
    });
    it('is false for /auth endpoints that establish nothing', () => {
      for (const p of ['/auth/logout', '/auth/otp/send', '/auth/me', '/users']) {
        expect(isAuthEstablishPath(p)).toBe(false);
      }
    });
  });

  describe('reference-id helpers', () => {
    it('toSnakeCase normalizes camel / kebab / spaced', () => {
      expect(toSnakeCase('countryId')).toBe('country_id');
      expect(toSnakeCase('country-id')).toBe('country_id');
    });
    it('singularize handles ies / s', () => {
      expect(singularize('countries')).toBe('country');
      expect(singularize('cities')).toBe('city');
      expect(singularize('files')).toBe('file');
    });
    it('lastPathSegment strips /api/vN and {param} parts', () => {
      expect(lastPathSegment('/api/v1/countries')).toBe('countries');
      expect(lastPathSegment('/api/v2/students/{id}')).toBe('students');
    });
    it('isReferenceIdField / isSnakeIdVar', () => {
      expect(isReferenceIdField('userId')).toBe(true);
      expect(isReferenceIdField('name')).toBe(false);
      expect(isSnakeIdVar('country_id')).toBe(true);
      expect(isSnakeIdVar('countryId')).toBe(false);
    });
  });

  // #7 — send/verify/teardown vocabulary must cover real-world naming, not just
  // logout + verify.
  describe('send / verify / teardown steps', () => {
    it('recognises verify AND submit/complete as verify steps', () => {
      expect(isVerifyStep('/auth/otp/verify')).toBe(true);
      expect(isVerifyStep('/auth/mfa/submit')).toBe(true); // was neither send nor verify
      expect(isVerifyStep('/auth/registration/complete')).toBe(true);
      expect(isVerifyStep('/auth/login')).toBe(false);
    });

    it('recognises send / request steps', () => {
      expect(isSendStep('/auth/mfa/send')).toBe(true);
      expect(isSendStep('/auth/otp/request')).toBe(true);
      expect(isSendStep('/auth/otp/verify')).toBe(false);
    });

    it('recognises revoke / terminate / end-session as teardowns', () => {
      expect(isSessionTeardown('/auth/logout')).toBe(true);
      expect(isSessionTeardown('/token/revoke')).toBe(true);
      expect(isSessionTeardown('/session/revoke')).toBe(true);
      expect(isSessionTeardown('/sessions/terminate')).toBe(true);
      expect(isSessionTeardown('/auth/end-session')).toBe(true);
      expect(isSessionTeardown('/session/invalidate')).toBe(true);
      expect(isSessionTeardown('/auth/login')).toBe(false);
      expect(isSessionTeardown('/users/{id}')).toBe(false);
    });
  });
});
