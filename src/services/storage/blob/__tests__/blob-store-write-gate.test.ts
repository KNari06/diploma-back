import { __setBlobStoreForTests, getBlobStore, getBlobStoreForWrite, type BlobStore } from '../index';

/** Minimal stand-in — only `provider` matters to the write gate. */
function storeWithProvider(provider: BlobStore['provider']): BlobStore {
  return { provider } as BlobStore;
}

describe('getBlobStoreForWrite', () => {
  afterEach(() => {
    __setBlobStoreForTests(null);
  });

  it('refuses to hand back a supabase store for writing an app binary', () => {
    __setBlobStoreForTests(storeWithProvider('supabase'));
    expect(() => getBlobStoreForWrite()).toThrow(/Azure-only/);
  });

  it('names the variable to set so a misconfigured environment is self-diagnosing', () => {
    __setBlobStoreForTests(storeWithProvider('supabase'));
    expect(() => getBlobStoreForWrite()).toThrow(/MOBILE_APP_STORAGE_PROVIDER=azure/);
  });

  it('returns the azure store for writing', () => {
    const azure = storeWithProvider('azure');
    __setBlobStoreForTests(azure);
    expect(getBlobStoreForWrite()).toBe(azure);
  });

  it('leaves reads on supabase alone so legacy objects stay fetchable', () => {
    // The dual-read fallback is the whole reason Supabase is still wired up;
    // gating reads would strand every pre-cutover binary.
    const supabase = storeWithProvider('supabase');
    __setBlobStoreForTests(supabase);
    expect(getBlobStore()).toBe(supabase);
  });
});
