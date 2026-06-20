import { isDynamicId } from '../dynamic-id.util';

describe('isDynamicId — shape-based generated ids', () => {
  it('flags UUIDs, Mongo ids, long tokens, and epoch-like numbers', () => {
    expect(isDynamicId('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isDynamicId('507f1f77bcf86cd799439011')).toBe(true); // Mongo ObjectId
    expect(isDynamicId('0123456789abcdefghij')).toBe(true); // 20-char token
    expect(isDynamicId('1700000000')).toBe(true); // epoch-like
  });
});

describe('isDynamicId — framework-generated ids', () => {
  it('flags known framework / UI-library counter ids', () => {
    expect(isDynamicId('react-select-2-input')).toBe(true);
    expect(isDynamicId('react-tabs-1')).toBe(true);
    expect(isDynamicId('ember42')).toBe(true);
    expect(isDynamicId(':r0:')).toBe(true); // React 18 useId
    expect(isDynamicId('el-id-6868-3')).toBe(true); // Element Plus
    expect(isDynamicId('radix-abc123')).toBe(true);
    expect(isDynamicId('mui-1234')).toBe(true);
    expect(isDynamicId('chakra-input-1')).toBe(true);
    expect(isDynamicId('__BVID__42')).toBe(true); // BootstrapVue
  });

  it('flags CSS-in-JS scoped hashes used as ids', () => {
    expect(isDynamicId('css-1q2w3e')).toBe(true); // Emotion
    expect(isDynamicId('sc-jJLAfE')).toBe(true); // styled-components
    expect(isDynamicId('jss42')).toBe(true); // MUI v4 JSS
  });
});

describe('isDynamicId — legitimate static ids', () => {
  it('does NOT flag human-named ids (including narrowly-scoped framework prefixes)', () => {
    expect(isDynamicId('submit-button')).toBe(false);
    expect(isDynamicId('login-form')).toBe(false);
    expect(isDynamicId('userName')).toBe(false);
    expect(isDynamicId('react-tutorial-link')).toBe(false); // narrowed react match excludes this
    expect(isDynamicId('main')).toBe(false);
    expect(isDynamicId('email')).toBe(false);
  });

  it('returns false for empty / null / undefined / whitespace', () => {
    expect(isDynamicId('')).toBe(false);
    expect(isDynamicId(null)).toBe(false);
    expect(isDynamicId(undefined)).toBe(false);
    expect(isDynamicId('   ')).toBe(false);
  });
});
