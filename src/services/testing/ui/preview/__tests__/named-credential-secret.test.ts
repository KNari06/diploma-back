import {
  classifySecretKeyName,
  mapSecretKeysToKinds,
  resolveNamedCredentialSecret,
  describeCredentialSecretFailure,
} from '../named-credential-secret';

jest.mock('@/services/test-resource/test-resource.service', () => ({
  listResources: jest.fn(),
  loadDecrypted: jest.fn(),
}));

const svc = require('@/services/test-resource/test-resource.service');

/**
 * The fixture below is the shape `loadDecrypted` ACTUALLY returns: `values` is
 * declared sensitive, so it comes back under `sensitive` and `config` is left
 * empty. A hand-written `config:{values}` fixture is what let the adapter bug
 * (L-0031) survive a green suite — do not "simplify" this.
 */
const decryptedSecret = (values: Record<string, string>) => ({
  id: 'res-1',
  kind: 'secret',
  name: 'Demo login',
  scope: {},
  config: {},
  sensitive: { values },
});

const summary = (over: Partial<{ id: string; name: string }> = {}) => ({
  id: 'res-1',
  name: 'Demo login',
  kind: 'secret',
  ...over,
});

beforeEach(() => jest.resetAllMocks());

describe('classifySecretKeyName', () => {
  it('maps the key names the product and fixture actually use', () => {
    // Both also match the `username` dictionary ("login"); precedence must win.
    expect(classifySecretKeyName('login_email')).toBe('email');
    expect(classifySecretKeyName('login_password')).toBe('password');
  });

  it('maps plain and multilingual names', () => {
    expect(classifySecretKeyName('password')).toBe('password');
    expect(classifySecretKeyName('пароль')).toBe('password');
    expect(classifySecretKeyName('email')).toBe('email');
    expect(classifySecretKeyName('username')).toBe('username');
    expect(classifySecretKeyName('phone')).toBe('phone');
  });

  it('returns null for a key with no credential signal', () => {
    expect(classifySecretKeyName('cred1')).toBeNull();
    expect(classifySecretKeyName('api_base')).toBeNull();
  });

  // A `secret` resource is this codebase's general-purpose store for API keys,
  // so these key names are EXPECTED contents. Under the DOM-label dictionary
  // they all read as "password" (its list contains the bare tokens `secret`,
  // `code`, `pin`, `pass`), which would hand a live API key to a login form.
  it('does NOT read API-key material as a password', () => {
    expect(classifySecretKeyName('client_secret')).toBeNull();
    expect(classifySecretKeyName('STRIPE_SECRET_KEY')).toBeNull();
    expect(classifySecretKeyName('signing_secret')).toBeNull();
    expect(classifySecretKeyName('webhook_secret')).toBeNull();
    expect(classifySecretKeyName('totp_secret')).toBeNull();
    expect(classifySecretKeyName('otp_code')).toBeNull();
  });

  it('matches on word boundaries, not substrings', () => {
    // "shiPPINg" contains "pin"; "passcode" is a PIN-style entry, not a login
    // password — the DOM dictionary maps both to `password`.
    expect(classifySecretKeyName('shipping_address')).toBeNull();
    expect(classifySecretKeyName('account_number')).toBeNull();
    expect(classifySecretKeyName('loginPassword')).toBe('password');
  });
});

describe('mapSecretKeysToKinds', () => {
  it('arbitrates by claim strength — an exact key beats a decorated one', () => {
    const { byKind, droppedKinds } = mapSecretKeysToKinds(['password', 'login_password', 'login_email']);
    expect(byKind.password).toBe('password');
    expect(droppedKinds).not.toContain('password');
  });

  it('drops a kind only on a genuine tie, and names the colliding keys', () => {
    const { byKind, droppedKinds, ambiguousKeys } = mapSecretKeysToKinds(['login_password', 'admin_password']);
    expect(byKind.password).toBeUndefined();
    expect(droppedKinds).toContain('password');
    expect(ambiguousKeys.password).toEqual(['login_password', 'admin_password']);
  });

  it('keeps a real login usable when it also stores a TOTP seed', () => {
    // The documented shape of a `secret` ("login storageState, TOTP seeds,
    // credential maps"). Under the DOM dictionary `totp_secret` also claimed
    // `password`, the kind was dropped, and the agent told the user their login
    // "has no password-like key (found: … login_password …)" — false, and
    // impossible to act on.
    const { byKind } = mapSecretKeysToKinds(['login_email', 'login_password', 'totp_secret']);
    expect(byKind.password).toBe('login_password');
    expect(byKind.email).toBe('login_email');
  });

  it('ignores a key the secret adapter itself would reject', () => {
    const { byKind } = mapSecretKeysToKinds(['9bad-password', 'login_email']);
    expect(byKind.password).toBeUndefined();
    expect(byKind.email).toBe('login_email');
  });
});

describe('resolveNamedCredentialSecret', () => {
  it('resolves values and key names from the sensitive envelope', async () => {
    svc.listResources.mockResolvedValue([summary()]);
    svc.loadDecrypted.mockResolvedValue(
      decryptedSecret({ login_email: 'demo@qait.dev', login_password: 'password' }),
    );

    const res = await resolveNamedCredentialSecret({
      userId: 'u1', projectId: 'p1', name: 'demo login',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resourceId).toBe('res-1');
    // Values reach the pipeline (so the agent can actually log in) ...
    expect(res.credentials).toEqual({ password: 'password', email: 'demo@qait.dev' });
    // ... while the binding carries key NAMES only.
    expect(res.credentialSecret).toEqual({
      resourceId: 'res-1', passwordKey: 'login_password', emailKey: 'login_email',
    });
    expect(res.valueToKey.get('demo@qait.dev')).toBe('login_email');
    expect(res.valueToKey.get('password')).toBe('login_password');
  });

  it('matches the name case-insensitively and trimmed', async () => {
    svc.listResources.mockResolvedValue([summary({ name: '  Demo Login ' })]);
    svc.loadDecrypted.mockResolvedValue(decryptedSecret({ pwd: 'x' }));

    const res = await resolveNamedCredentialSecret({ userId: 'u1', projectId: 'p1', name: 'demo login' });
    expect(res.ok).toBe(true);
  });

  it('fails closed with the available names when the name is unknown', async () => {
    svc.listResources.mockResolvedValue([summary({ name: 'Staging login' })]);

    const res = await resolveNamedCredentialSecret({ userId: 'u1', projectId: 'p1', name: 'demo' });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('not_found');
    expect(res.availableNames).toEqual(['Staging login']);
    expect(svc.loadDecrypted).not.toHaveBeenCalled();
  });

  it('fails closed when two secrets share the name', async () => {
    svc.listResources.mockResolvedValue([summary({ id: 'a' }), summary({ id: 'b' })]);

    const res = await resolveNamedCredentialSecret({ userId: 'u1', projectId: 'p1', name: 'Demo login' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('ambiguous');
  });

  it('fills the email slot from a username-only key so an email-typed field is still injected', async () => {
    // The executor cascades username -> email -> phone, but an EMAIL-classified
    // field has no fallback: it fills only from credentials.email and otherwise
    // leaves the model's throwaway value, so the live login fails. A secret
    // keyed {login, password} on a form with input[type=email] is common.
    svc.listResources.mockResolvedValue([summary()]);
    svc.loadDecrypted.mockResolvedValue(decryptedSecret({ login: 'demo', login_password: 'password' }));

    const res = await resolveNamedCredentialSecret({ userId: 'u1', projectId: 'p1', name: 'Demo login' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.credentials.email).toBe('demo');
    expect(res.credentials.username).toBe('demo');
  });

  it('reports an AMBIGUOUS password key rather than claiming there is none', async () => {
    svc.listResources.mockResolvedValue([summary()]);
    svc.loadDecrypted.mockResolvedValue(
      decryptedSecret({ login_password: 'a', admin_password: 'b', login_email: 'demo@qait.dev' }),
    );

    const res = await resolveNamedCredentialSecret({ userId: 'u1', projectId: 'p1', name: 'Demo login' });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('ambiguous_password_key');
    const msg = describeCredentialSecretFailure(res, 'Demo login');
    expect(msg).toContain('login_password');
    expect(msg).toContain('admin_password');
  });

  it('fails closed when the secret has no password-like key', async () => {
    svc.listResources.mockResolvedValue([summary()]);
    svc.loadDecrypted.mockResolvedValue(decryptedSecret({ login_email: 'demo@qait.dev' }));

    const res = await resolveNamedCredentialSecret({ userId: 'u1', projectId: 'p1', name: 'Demo login' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no_password_key');
  });

  it('fails closed when the envelope decrypted to nothing', async () => {
    svc.listResources.mockResolvedValue([summary()]);
    svc.loadDecrypted.mockResolvedValue({ ...decryptedSecret({}), sensitive: {} });

    const res = await resolveNamedCredentialSecret({ userId: 'u1', projectId: 'p1', name: 'Demo login' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no_values');
  });

  it('does NOT read values from config (invariant #9 — the L-0031 bug)', async () => {
    svc.listResources.mockResolvedValue([summary()]);
    svc.loadDecrypted.mockResolvedValue({
      ...decryptedSecret({}),
      config: { values: { login_password: 'password' } },
      sensitive: {},
    });

    const res = await resolveNamedCredentialSecret({ userId: 'u1', projectId: 'p1', name: 'Demo login' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no_values');
  });

  it('scopes the lookup to the caller and the session project', async () => {
    svc.listResources.mockResolvedValue([]);
    await resolveNamedCredentialSecret({ userId: 'u1', projectId: 'p1', name: 'x' });
    expect(svc.listResources).toHaveBeenCalledWith('u1', 'p1', { kind: 'secret' });
  });
});

describe('describeCredentialSecretFailure', () => {
  it('lists the available names so the agent can ask a specific question', () => {
    const msg = describeCredentialSecretFailure(
      { reason: 'not_found', availableNames: ['Demo login', 'Staging'] },
      'prod',
    );
    expect(msg).toContain('"Demo login"');
    expect(msg).toContain('Ask the user');
  });

  it('points at Settings when the project has no secrets', () => {
    const msg = describeCredentialSecretFailure({ reason: 'not_found', availableNames: [] }, 'demo');
    expect(msg).toContain('Settings');
  });
});
