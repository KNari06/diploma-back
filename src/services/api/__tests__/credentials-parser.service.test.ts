// The global jest.setup env mock omits ENCRYPTION_SECRET; provide it here so the
// real AES-256-GCM encrypt/decrypt round-trip works (this module only reads
// env.ENCRYPTION_SECRET).
jest.mock('@/config/environment/env', () => ({
  env: { ENCRYPTION_SECRET: 'test-encryption-secret-key-0123456789abcdef' },
}));

import { CredentialsParserService } from '../credentials-parser.service';

describe('parseNaturalCredentials — format detection', () => {
  it('parses JSON', () => {
    const r = CredentialsParserService.parseNaturalCredentials('{"email":"a@b.com","password":"p1"}');
    expect(r).toMatchObject({ email: 'a@b.com', password: 'p1' });
  });

  it('parses key-value with email and password', () => {
    const r = CredentialsParserService.parseNaturalCredentials('email: a@b.com, password: secret');
    expect(r).toEqual({ email: 'a@b.com', password: 'secret' });
  });

  it('preserves a quoted password containing commas/semicolons', () => {
    const r = CredentialsParserService.parseNaturalCredentials('email: a@b.com, password: "my,complex;pass"');
    expect(r.password).toBe('my,complex;pass');
  });

  it('parses key-value phone', () => {
    const r = CredentialsParserService.parseNaturalCredentials('phone: +77011234567, password: x');
    expect(r).toMatchObject({ phone: '+77011234567', password: 'x' });
  });

  it('parses slash format and classifies the login (email/phone/username)', () => {
    expect(CredentialsParserService.parseNaturalCredentials('a@b.com / pass')).toEqual({
      email: 'a@b.com',
      password: 'pass',
    });
    expect(CredentialsParserService.parseNaturalCredentials('+77011234567 / pass')).toEqual({
      phone: '+77011234567',
      password: 'pass',
    });
    expect(CredentialsParserService.parseNaturalCredentials('admin / pass')).toEqual({
      username: 'admin',
      password: 'pass',
    });
  });

  it('splits slash format on the FIRST delimiter, preserving / in the password', () => {
    expect(CredentialsParserService.parseNaturalCredentials('admin / P@ss/word!')).toEqual({
      username: 'admin',
      password: 'P@ss/word!',
    });
  });

  it('parses pipe format', () => {
    expect(CredentialsParserService.parseNaturalCredentials('user | pw')).toEqual({
      username: 'user',
      password: 'pw',
    });
  });

  it('parses space format with exactly two parts', () => {
    expect(CredentialsParserService.parseNaturalCredentials('a@b.com 123456')).toEqual({
      email: 'a@b.com',
      password: '123456',
    });
    expect(CredentialsParserService.parseNaturalCredentials('user 123456')).toEqual({
      username: 'user',
      password: '123456',
    });
  });

  it('parses newline format', () => {
    expect(CredentialsParserService.parseNaturalCredentials('a@b.com\nsecret')).toEqual({
      email: 'a@b.com',
      password: 'secret',
    });
  });

  it('throws when no format matches', () => {
    expect(() => CredentialsParserService.parseNaturalCredentials('garbage')).toThrow(/Cannot parse/);
  });
});

describe('encrypt / decrypt round-trip', () => {
  it('round-trips all fields back to the originals', () => {
    const creds = { email: 'a@b.com', username: 'alice', phone: '+77011234567', password: 'S3cr3t!' };
    const enc = CredentialsParserService.encryptCredentials(creds);
    expect(CredentialsParserService.decryptCredentials(enc)).toEqual(creds);
  });

  it('encrypts only the password when optional fields are absent', () => {
    const enc = CredentialsParserService.encryptCredentials({ password: 'only-pass' });
    expect(enc.email_encrypted).toBeUndefined();
    expect(enc.username_encrypted).toBeUndefined();
    expect(enc.phone_encrypted).toBeUndefined();
    expect(typeof enc.password_encrypted).toBe('string');
    expect(CredentialsParserService.decryptCredentials(enc)).toEqual({ password: 'only-pass' });
  });

  it('produces base64 ciphertext that differs from plaintext and is non-deterministic', () => {
    const a = CredentialsParserService.encryptCredentials({ password: 'same' });
    const b = CredentialsParserService.encryptCredentials({ password: 'same' });
    expect(a.password_encrypted).not.toBe('same');
    // Random IV + salt → two encryptions of the same value differ.
    expect(a.password_encrypted).not.toBe(b.password_encrypted);
    // Both still decrypt back to the same plaintext.
    expect(CredentialsParserService.decryptCredentials(a).password).toBe('same');
    expect(CredentialsParserService.decryptCredentials(b).password).toBe('same');
  });

  it('throws when decrypting tampered ciphertext (GCM auth tag)', () => {
    const enc = CredentialsParserService.encryptCredentials({ password: 'p' });
    const tampered = { password_encrypted: Buffer.from('not-valid-ciphertext').toString('base64') };
    expect(() => CredentialsParserService.decryptCredentials(tampered)).toThrow(/Failed to decrypt/);
    void enc;
  });
});
