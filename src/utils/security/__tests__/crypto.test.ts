import {
  encryptString,
  decryptString,
  encryptJSON,
  decryptJSON,
} from '../crypto';

describe('encryptString / decryptString', () => {
  it('round-trips a plaintext value', () => {
    const plain = 'super-secret-password';
    expect(decryptString(encryptString(plain))).toBe(plain);
  });

  it('round-trips unicode and empty strings', () => {
    expect(decryptString(encryptString(''))).toBe('');
    expect(decryptString(encryptString('пароль 🔐 секрет'))).toBe('пароль 🔐 секрет');
  });

  it('produces the "iv:authTag:ciphertext" hex format', () => {
    const out = encryptString('hello');
    const parts = out.split(':');
    expect(parts).toHaveLength(3);
    parts.forEach((p) => expect(p).toMatch(/^[0-9a-f]+$/));
    // iv is 16 bytes -> 32 hex chars; GCM auth tag is 16 bytes -> 32 hex chars
    expect(parts[0]).toHaveLength(32);
    expect(parts[1]).toHaveLength(32);
  });

  it('uses a random IV so the same plaintext encrypts differently each time', () => {
    expect(encryptString('same')).not.toBe(encryptString('same'));
  });

  it('throws on a malformed ciphertext (wrong number of segments)', () => {
    expect(() => decryptString('not-valid')).toThrow('Failed to decrypt');
    expect(() => decryptString('only:two')).toThrow('Failed to decrypt');
  });

  it('throws when the ciphertext has been tampered with (auth tag mismatch)', () => {
    const out = encryptString('integrity-protected');
    const [iv, tag, ct] = out.split(':');
    const flipped = ct.slice(0, -1) + (ct.endsWith('0') ? '1' : '0');
    expect(() => decryptString(`${iv}:${tag}:${flipped}`)).toThrow('Failed to decrypt');
  });
});

describe('encryptJSON / decryptJSON', () => {
  it('round-trips an object', () => {
    const value = { user: 'a@b.com', roles: ['admin'], n: 7, nested: { ok: true } };
    expect(decryptJSON(encryptJSON(value))).toEqual(value);
  });

  it('round-trips primitive JSON values', () => {
    expect(decryptJSON<number>(encryptJSON(42))).toBe(42);
    expect(decryptJSON<boolean>(encryptJSON(false))).toBe(false);
    expect(decryptJSON<null>(encryptJSON(null))).toBeNull();
  });
});
