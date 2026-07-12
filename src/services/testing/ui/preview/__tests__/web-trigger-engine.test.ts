import type { Page } from 'playwright';
import { SnapshotRouter } from '../snapshot-router.service';
import { OverlayDismisser } from '@/agent/core/lite/exploration/overlay-dismisser';
import {
  conditionMatchesOverlay,
  matchOverlayTrigger,
  matchOverlayTriggers,
  runWebTriggerAction,
  checkAndHandleWebOverlayTrigger,
  detectOverlay,
  buildTriggerFiredPayload,
  type Trigger,
} from '../web-trigger-engine';

jest.mock('../snapshot-router.service', () => ({
  SnapshotRouter: { collect: jest.fn() },
}));
jest.mock('@/agent/core/lite/exploration/overlay-dismisser', () => ({
  OverlayDismisser: { classifyObstacles: jest.fn(), filterDismissible: jest.fn() },
  ESCAPE_KEY: 'Escape',
}));

const mockCollect = SnapshotRouter.collect as jest.Mock;
const mockClassify = OverlayDismisser.classifyObstacles as jest.Mock;
const mockFilter = OverlayDismisser.filterDismissible as jest.Mock;

function makeObstacle(textPreview: string) {
  return { ref: 'e1', textPreview, hintType: 'modal' } as any;
}

/**
 * Builds a mock Page for the tap-action path. The tap logic first scopes to
 * the topmost dialog (`page.locator(...).last().getByText(...).first()`),
 * checks `.count()`, and clicks either that or the page-scoped fallback.
 * `dialogCount` controls whether the dialog scope resolves a match (>0) so we
 * can exercise both the scoped and the fallback branch.
 */
function makePage({ dialogCount = 1 }: { dialogCount?: number } = {}) {
  const dialogClick = jest.fn().mockResolvedValue(undefined);
  const dialogDispatch = jest.fn().mockResolvedValue(undefined);
  const dialogTarget = { count: jest.fn().mockResolvedValue(dialogCount), click: dialogClick, dispatchEvent: dialogDispatch };

  const pageClick = jest.fn().mockResolvedValue(undefined);
  const pageDispatch = jest.fn().mockResolvedValue(undefined);
  const pageTarget = { count: jest.fn().mockResolvedValue(1), click: pageClick, dispatchEvent: pageDispatch };

  const dialogGetByText = jest.fn(() => ({ first: () => dialogTarget }));
  const locator = jest.fn(() => ({ last: () => ({ getByText: dialogGetByText }) }));
  const getByText = jest.fn(() => ({ first: () => pageTarget }));
  const press = jest.fn().mockResolvedValue(undefined);
  return {
    page: {
      locator,
      getByText,
      keyboard: { press },
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
    } as unknown as Page,
    locator,
    getByText,
    dialogGetByText,
    dialogClick,
    dialogDispatch,
    pageClick,
    pageDispatch,
    press,
  };
}

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 't1',
    condition: { kind: 'any_dialog' },
    action: { kind: 'back' },
    ...overrides,
  } as Trigger;
}

describe('web-trigger-engine / conditionMatchesOverlay', () => {
  it('matches any_dialog against any detected overlay', () => {
    expect(conditionMatchesOverlay({ kind: 'any_dialog' }, { text: 'anything' })).toBe(true);
  });

  it('matches dialog_text when the overlay text contains the needle, case/Unicode-insensitive', () => {
    const condition = { kind: 'dialog_text' as const, contains: 'СКИДКА' };
    expect(conditionMatchesOverlay(condition, { text: 'Специальная скидка 20%' })).toBe(true);
  });

  it('does not match dialog_text when the needle is absent', () => {
    const condition = { kind: 'dialog_text' as const, contains: 'survey' };
    expect(conditionMatchesOverlay(condition, { text: 'Subscribe to our newsletter' })).toBe(false);
  });

  it('never matches permission_dialog against a DOM overlay', () => {
    expect(conditionMatchesOverlay({ kind: 'permission_dialog' }, { text: 'Allow location access?' })).toBe(false);
  });
});

describe('web-trigger-engine / matchOverlayTrigger', () => {
  it('returns the first trigger whose condition matches, in order', () => {
    const triggers = [
      makeTrigger({ id: 'a', condition: { kind: 'dialog_text', contains: 'survey' } }),
      makeTrigger({ id: 'b', condition: { kind: 'any_dialog' } }),
    ];
    expect(matchOverlayTrigger(triggers, { text: 'Sale popup' })?.id).toBe('b');
  });

  it('returns null when no trigger matches', () => {
    const triggers = [makeTrigger({ condition: { kind: 'dialog_text', contains: 'survey' } })];
    expect(matchOverlayTrigger(triggers, { text: 'Sale popup' })).toBeNull();
  });
});

describe('web-trigger-engine / matchOverlayTriggers', () => {
  it('returns every condition-matching trigger in authored order (so the handler can skip a failing one)', () => {
    const triggers = [
      makeTrigger({ id: 'a', condition: { kind: 'dialog_text', contains: 'survey' } }),
      makeTrigger({ id: 'b', condition: { kind: 'any_dialog' } }),
      makeTrigger({ id: 'c', condition: { kind: 'any_dialog' } }),
    ];
    expect(matchOverlayTriggers(triggers, { text: 'Sale popup' }).map((t) => t.id)).toEqual(['b', 'c']);
  });

  it('returns an empty array when nothing matches', () => {
    const triggers = [makeTrigger({ condition: { kind: 'dialog_text', contains: 'survey' } })];
    expect(matchOverlayTriggers(triggers, { text: 'Sale popup' })).toEqual([]);
  });
});

describe('web-trigger-engine / runWebTriggerAction', () => {
  it('tap scopes to the topmost dialog and clicks the element there (not a same-text copy behind the modal)', async () => {
    const { page, dialogGetByText, dialogClick, pageClick } = makePage({ dialogCount: 1 });
    const trigger = makeTrigger({ action: { kind: 'tap', text: 'Астана' } });

    const result = await runWebTriggerAction(page, trigger);

    expect(result).toBe(true);
    expect(dialogGetByText).toHaveBeenCalledWith('Астана', { exact: false });
    expect(dialogClick).toHaveBeenCalled();
    // The page-scoped fallback must NOT be used when the dialog has the target.
    expect(pageClick).not.toHaveBeenCalled();
  });

  it('tap falls back to page scope when the overlay is not a role=dialog (e.g. a plain promo div)', async () => {
    const { page, getByText, pageClick, dialogClick } = makePage({ dialogCount: 0 });
    const trigger = makeTrigger({ action: { kind: 'tap', text: 'No thanks' } });

    const result = await runWebTriggerAction(page, trigger);

    expect(result).toBe(true);
    expect(getByText).toHaveBeenCalledWith('No thanks', { exact: false });
    expect(pageClick).toHaveBeenCalled();
    expect(dialogClick).not.toHaveBeenCalled();
  });

  it('tap returns false without touching the page when the action text is empty', async () => {
    const { page, getByText, locator } = makePage();
    const trigger = makeTrigger({ action: { kind: 'tap', text: '  ' } });

    const result = await runWebTriggerAction(page, trigger);

    expect(result).toBe(false);
    expect(getByText).not.toHaveBeenCalled();
    expect(locator).not.toHaveBeenCalled();
  });

  it('back presses Escape', async () => {
    const { page, press } = makePage();
    const trigger = makeTrigger({ action: { kind: 'back' } });

    const result = await runWebTriggerAction(page, trigger);

    expect(result).toBe(true);
    expect(press).toHaveBeenCalledWith('Escape');
  });

  it('permission action never touches the page and returns false', async () => {
    const { page, getByText, locator, press } = makePage();
    const trigger = makeTrigger({ action: { kind: 'permission', decision: 'deny' } });

    const result = await runWebTriggerAction(page, trigger);

    expect(result).toBe(false);
    expect(getByText).not.toHaveBeenCalled();
    expect(locator).not.toHaveBeenCalled();
    expect(press).not.toHaveBeenCalled();
  });

  it('dispatches the click event directly on the element when a coordinate click is intercepted (Radix/shadcn backdrop)', async () => {
    const { page, dialogClick, dialogDispatch } = makePage({ dialogCount: 1 });
    dialogClick.mockRejectedValueOnce(new Error('locator.click: intercepts pointer events'));
    const trigger = makeTrigger({ action: { kind: 'tap', text: 'Все города Казахстана' } });

    const result = await runWebTriggerAction(page, trigger);

    expect(result).toBe(true);
    expect(dialogClick).toHaveBeenCalledTimes(1);
    // dispatchEvent bypasses coordinate hit-testing, so a backdrop can't swallow it.
    expect(dialogDispatch).toHaveBeenCalledWith('click');
  });

  it('returns false when both the coordinate click and the dispatchEvent fallback throw', async () => {
    const { page, dialogClick, dialogDispatch } = makePage({ dialogCount: 1 });
    dialogClick.mockRejectedValue(new Error('element not visible'));
    dialogDispatch.mockRejectedValue(new Error('element detached'));
    const trigger = makeTrigger({ action: { kind: 'tap', text: 'Close' } });

    await expect(runWebTriggerAction(page, trigger)).resolves.toBe(false);
    expect(dialogClick).toHaveBeenCalledTimes(1);
    expect(dialogDispatch).toHaveBeenCalledTimes(1);
  });
});

describe('web-trigger-engine / buildTriggerFiredPayload', () => {
  it('carries the trigger id + tap target so the UI can name the exact trigger', () => {
    const trigger = makeTrigger({ id: 'trg-1', condition: { kind: 'any_dialog' }, action: { kind: 'tap', text: 'Астана' } });
    const p = buildTriggerFiredPayload(trigger, 'Где вы планируете...');
    expect(p.triggerId).toBe('trg-1');
    expect(p.conditionKind).toBe('any_dialog');
    expect(p.actionKind).toBe('tap');
    expect(p.actionText).toBe('Астана');
    expect(p.matchedText).toBe('Где вы планируете...');
    expect(typeof p.timestamp).toBe('string');
    // Fields that don't apply to this trigger are omitted, not null.
    expect('conditionContains' in p).toBe(false);
    expect('actionDecision' in p).toBe(false);
  });

  it('carries conditionContains for dialog_text and actionDecision for permission', () => {
    const dt = buildTriggerFiredPayload(
      makeTrigger({ condition: { kind: 'dialog_text', contains: 'survey' }, action: { kind: 'back' } }),
    );
    expect(dt.conditionKind).toBe('dialog_text');
    expect(dt.conditionContains).toBe('survey');
    expect(dt.actionKind).toBe('back');

    const perm = buildTriggerFiredPayload(
      makeTrigger({ condition: { kind: 'permission_dialog' }, action: { kind: 'permission', decision: 'deny' } }),
    );
    expect(perm.actionKind).toBe('permission');
    expect(perm.actionDecision).toBe('deny');
    // No overlay text on the native-dialog path.
    expect('matchedText' in perm).toBe(false);
  });
});

describe('web-trigger-engine / detectOverlay', () => {
  beforeEach(() => {
    mockCollect.mockReset();
    mockClassify.mockReset();
    mockFilter.mockReset();
  });

  it('returns null when SnapshotRouter finds no obstacles', async () => {
    mockCollect.mockResolvedValue({ obstacleFacts: [] });
    const { page } = makePage();

    expect(await detectOverlay(page)).toBeNull();
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('returns null when every obstacle is filtered out (e.g. a sticky navbar, not a real overlay)', async () => {
    const obstacle = makeObstacle('Home About Contact');
    mockCollect.mockResolvedValue({ obstacleFacts: [obstacle] });
    mockClassify.mockReturnValue([{ fact: obstacle, type: 'unknown' }]);
    mockFilter.mockReturnValue([]);
    const { page } = makePage();

    expect(await detectOverlay(page)).toBeNull();
  });

  it('returns the joined text of dismissible obstacles', async () => {
    const obstacle = makeObstacle('Get 20% off your first order!');
    mockCollect.mockResolvedValue({ obstacleFacts: [obstacle], viewport: { width: 1280, height: 800 } });
    mockClassify.mockReturnValue([{ fact: obstacle, type: 'modal' }]);
    mockFilter.mockReturnValue([{ fact: obstacle, type: 'modal' }]);
    const { page } = makePage();

    const result = await detectOverlay(page);
    expect(result?.text).toContain('20% off');
  });

  it('returns null instead of throwing when SnapshotRouter itself fails', async () => {
    mockCollect.mockRejectedValue(new Error('page closed'));
    const { page } = makePage();

    await expect(detectOverlay(page)).resolves.toBeNull();
  });
});

describe('web-trigger-engine / checkAndHandleWebOverlayTrigger', () => {
  beforeEach(() => {
    mockCollect.mockReset();
    mockClassify.mockReset();
    mockFilter.mockReset();
  });

  it('returns not-fired and skips detection entirely when no triggers are configured', async () => {
    const { page } = makePage();
    const result = await checkAndHandleWebOverlayTrigger(page, []);

    expect(result).toEqual({ fired: false });
    expect(mockCollect).not.toHaveBeenCalled();
  });

  it('returns not-fired when no overlay is detected', async () => {
    mockCollect.mockResolvedValue({ obstacleFacts: [] });
    const { page } = makePage();

    const result = await checkAndHandleWebOverlayTrigger(page, [makeTrigger()]);
    expect(result.fired).toBe(false);
  });

  it('fires the matching trigger and returns its identity', async () => {
    const obstacle = makeObstacle('Take our survey');
    mockCollect.mockResolvedValueOnce({ obstacleFacts: [obstacle] }).mockResolvedValue({ obstacleFacts: [] });
    mockClassify.mockReturnValue([{ fact: obstacle, type: 'modal' }]);
    mockFilter.mockReturnValue([{ fact: obstacle, type: 'modal' }]);
    const { page } = makePage();
    const trigger = makeTrigger({ id: 'survey-trigger', action: { kind: 'back' } });

    const result = await checkAndHandleWebOverlayTrigger(page, [trigger]);

    expect(result).toEqual({ fired: true, trigger, matchedText: 'Take our survey' });
  });

  it('skips a matching trigger whose action fails and fires the next matching trigger instead', async () => {
    const obstacle = makeObstacle('Promo popup');
    mockCollect.mockResolvedValueOnce({ obstacleFacts: [obstacle] }).mockResolvedValue({ obstacleFacts: [] });
    mockClassify.mockReturnValue([{ fact: obstacle, type: 'modal' }]);
    mockFilter.mockReturnValue([{ fact: obstacle, type: 'modal' }]);
    const { page, dialogClick, dialogDispatch, press } = makePage({ dialogCount: 1 });
    // The first trigger's tap label isn't on this overlay — both the click and
    // the dispatchEvent fallback throw, so its action returns false.
    dialogClick.mockRejectedValue(new Error('no such text'));
    dialogDispatch.mockRejectedValue(new Error('no such text'));
    const tapClose = makeTrigger({ id: 'tap-close', action: { kind: 'tap', text: 'Close' } });
    const goBack = makeTrigger({ id: 'go-back', action: { kind: 'back' } });

    const result = await checkAndHandleWebOverlayTrigger(page, [tapClose, goBack]);

    // The working second trigger fired — the failing first match did NOT abort the overlay.
    expect(result.fired).toBe(true);
    expect(result.trigger?.id).toBe('go-back');
    expect(press).toHaveBeenCalledWith('Escape');
  });

  it('clears stacked DISTINCT overlays in sequence, firing a different trigger for each', async () => {
    const cookie = makeObstacle('We use cookies on this site');
    const sale = makeObstacle('Get 20% off your first order');
    // Overlay A (cookie banner), then a DIFFERENT overlay B (sale popup) once A
    // is cleared, then nothing.
    mockCollect
      .mockResolvedValueOnce({ obstacleFacts: [cookie] })
      .mockResolvedValueOnce({ obstacleFacts: [sale] })
      .mockResolvedValue({ obstacleFacts: [] });
    mockClassify.mockImplementation((facts: any[]) => facts.map((fact) => ({ fact, type: 'modal' })));
    mockFilter.mockImplementation((classified: any[]) => classified);
    const { page, dialogClick } = makePage({ dialogCount: 1 });

    const acceptCookies = makeTrigger({
      id: 'cookies', condition: { kind: 'dialog_text', contains: 'cookies' }, action: { kind: 'tap', text: 'Accept' },
    });
    const closeSale = makeTrigger({
      id: 'sale', condition: { kind: 'dialog_text', contains: '20% off' }, action: { kind: 'tap', text: 'No thanks' },
    });

    const result = await checkAndHandleWebOverlayTrigger(page, [acceptCookies, closeSale]);

    // Both overlays cleared; lastFired reflects the second (sale) trigger.
    expect(result.fired).toBe(true);
    expect(result.trigger?.id).toBe('sale');
    expect(result.matchedText).toContain('20% off');
    expect(dialogClick).toHaveBeenCalledTimes(2);
  });

  it('stops after MAX_ACTIVATIONS_PER_STEP when the action keeps reopening the same overlay', async () => {
    const obstacle = makeObstacle('Sign up now');
    mockCollect.mockResolvedValue({ obstacleFacts: [obstacle] }); // always present, action never clears it
    mockClassify.mockReturnValue([{ fact: obstacle, type: 'modal' }]);
    mockFilter.mockReturnValue([{ fact: obstacle, type: 'modal' }]);
    const { page, press } = makePage();
    const trigger = makeTrigger({ action: { kind: 'back' } });

    const result = await checkAndHandleWebOverlayTrigger(page, [trigger]);

    expect(result.fired).toBe(true);
    expect(press).toHaveBeenCalledTimes(3); // MAX_ACTIVATIONS_PER_STEP
  });
});
