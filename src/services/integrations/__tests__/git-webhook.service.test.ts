/**
 * Unit tests for GitWebhookService.receiveAndEnqueue — focused on the FAIL-CLOSED
 * signature-verification guard. A webhook must be REJECTED unless it carries a
 * signature AND a matched integration has a non-empty secret that validates it.
 * The old guard was fail-open: an integration auto-created with an empty secret
 * caused verification to be skipped, letting anyone knowing the repo URL trigger runs.
 *
 * Collaborators (GitIntegrationService, QueueManager, supabase) are stubbed at their
 * module boundary — we assert on the verification outcome, not the DB.
 */

import crypto from 'crypto';

const findAllByProviderAndRepositoryUrl = jest.fn();
const tryCreate = jest.fn();
const addGitWebhookJob = jest.fn();

jest.mock('../git-integration.service', () => ({
  GitIntegrationService: {
    findAllByProviderAndRepositoryUrl: (...a: any[]) => findAllByProviderAndRepositoryUrl(...a),
  },
}));

jest.mock('@/config/infrastructure/queues', () => ({
  QueueManager: { addGitWebhookJob: (...a: any[]) => addGitWebhookJob(...a) },
}));

jest.mock('@/db/supabase', () => ({ supabaseAdmin: {} }));
jest.mock('@/utils/core/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { GitWebhookService } from '../git-webhook.service';

const REPO = 'https://github.com/acme/api';
const PUSH_PAYLOAD = { ref: 'refs/heads/main', repository: { html_url: REPO } };
const RAW = JSON.stringify(PUSH_PAYLOAD);
const SECRET = 's3cr3t';

function ghSig(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

const base = {
  provider: 'github' as const,
  deliveryId: 'd1',
  eventType: 'push' as const,
  rawBody: RAW,
  payload: PUSH_PAYLOAD,
};

beforeEach(() => {
  jest.clearAllMocks();
  // Make persistDelivery / updateDeliveryStatus no-ops so we reach the enqueue path.
  jest.spyOn(GitWebhookService as any, 'persistDelivery').mockResolvedValue({ isDuplicate: false });
  jest.spyOn(GitWebhookService as any, 'updateDeliveryStatus').mockResolvedValue(undefined);
  jest.spyOn(GitWebhookService as any, 'tryCreateIntegrationFromMatchingPlan').mockImplementation((...a: any[]) => tryCreate(...a));
});

describe('receiveAndEnqueue — fail-closed signature verification', () => {
  it('rejects when no integration has a secret (empty-secret auto-created row)', async () => {
    findAllByProviderAndRepositoryUrl.mockResolvedValue([
      { id: 'i1', repository_url: REPO, webhook_secret: '' },
    ]);

    await expect(
      GitWebhookService.receiveAndEnqueue({ ...base, signature: ghSig(RAW, SECRET) }),
    ).rejects.toThrow(/webhook signature required/i);
    expect(addGitWebhookJob).not.toHaveBeenCalled();
  });

  it('rejects when signature header is missing even though a secret is configured', async () => {
    findAllByProviderAndRepositoryUrl.mockResolvedValue([
      { id: 'i1', repository_url: REPO, webhook_secret: SECRET },
    ]);

    await expect(
      GitWebhookService.receiveAndEnqueue({ ...base, signature: '' }),
    ).rejects.toThrow(/webhook signature required/i);
    expect(addGitWebhookJob).not.toHaveBeenCalled();
  });

  it('rejects when the signature does not match the configured secret', async () => {
    findAllByProviderAndRepositoryUrl.mockResolvedValue([
      { id: 'i1', repository_url: REPO, webhook_secret: SECRET },
    ]);

    await expect(
      GitWebhookService.receiveAndEnqueue({ ...base, signature: ghSig(RAW, 'wrong-secret') }),
    ).rejects.toThrow(/invalid github webhook signature/i);
    expect(addGitWebhookJob).not.toHaveBeenCalled();
  });

  it('accepts and enqueues when the signature matches a configured secret', async () => {
    findAllByProviderAndRepositoryUrl.mockResolvedValue([
      { id: 'i1', repository_url: REPO, webhook_secret: SECRET },
    ]);

    const result = await GitWebhookService.receiveAndEnqueue({ ...base, signature: ghSig(RAW, SECRET) });

    expect(result.queued).toBe(true);
    expect(addGitWebhookJob).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'github', integrationId: 'i1' }),
    );
  });

  it('validates against the right secret when multiple integrations share the repo', async () => {
    findAllByProviderAndRepositoryUrl.mockResolvedValue([
      { id: 'i1', repository_url: REPO, webhook_secret: 'other-secret' },
      { id: 'i2', repository_url: REPO, webhook_secret: SECRET },
    ]);

    const result = await GitWebhookService.receiveAndEnqueue({ ...base, signature: ghSig(RAW, SECRET) });

    expect(result.queued).toBe(true);
    expect(addGitWebhookJob).toHaveBeenCalledTimes(2);
  });
});
