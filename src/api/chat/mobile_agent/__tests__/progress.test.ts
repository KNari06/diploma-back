jest.mock('@/api/chat/shared/utils', () => ({ emitProcessingStep: jest.fn() }));

import {
  humanizeMobileToolName,
  mobileToolProgress,
  emitMobileAgentThinking,
  emitMobileToolStep,
  emitMobilePlanningStep,
} from '../progress';
import { emitProcessingStep } from '@/api/chat/shared/utils';

const emitMock = emitProcessingStep as jest.Mock;

describe('humanizeMobileToolName', () => {
  it.each([
    ['observe_mobile_page', 'Reading screen'],
    ['tap_element', 'Tapping element'],
    ['type_text', 'Typing'],
    ['mobile_create_test_case', 'Saving test case'],
  ])('maps the known tool %p to %p', (name, label) => {
    expect(humanizeMobileToolName(name)).toBe(label);
  });

  it('humanizes an unknown snake_case name', () => {
    expect(humanizeMobileToolName('some_unknown_tool')).toBe('Some unknown tool');
  });

  it('capitalizes a single-word fallback', () => {
    expect(humanizeMobileToolName('frobnicate')).toBe('Frobnicate');
  });
});

describe('mobileToolProgress', () => {
  it('returns the 55% floor for round 0 or below', () => {
    expect(mobileToolProgress(0)).toBe(55);
    expect(mobileToolProgress(-3)).toBe(55);
  });

  it('reaches the 95% ceiling at the final round', () => {
    expect(mobileToolProgress(30, 30)).toBe(95);
  });

  it('saturates at 95% beyond the max round', () => {
    expect(mobileToolProgress(100, 30)).toBe(95);
  });

  it('interpolates linearly across the 55-95 range', () => {
    expect(mobileToolProgress(15, 30)).toBe(75); // halfway → 55 + 20
  });

  it('uses a default max of 30', () => {
    expect(mobileToolProgress(15)).toBe(75);
  });
});

describe('emit wrappers', () => {
  it('emitMobileAgentThinking forwards an agent_thinking step', () => {
    emitMobileAgentThinking('sid', 'Thinking…', 60, { foo: 1 });
    expect(emitMock).toHaveBeenCalledWith('sid', 'agent_thinking', 'Thinking…', 60, { foo: 1 });
  });

  it('emitMobilePlanningStep forwards an agent_planning step', () => {
    emitMobilePlanningStep('sid', 'Plan ready', 70);
    expect(emitMock).toHaveBeenCalledWith('sid', 'agent_planning', 'Plan ready', 70, undefined);
  });

  describe('emitMobileToolStep', () => {
    it('renders a "started" message with the humanized label and metadata', () => {
      emitMobileToolStep('sid', 'observe_mobile_page', 'started', 65, { round: 1 });
      expect(emitMock).toHaveBeenCalledWith('sid', 'agent_executing_tool', 'Reading screen…', 65, {
        toolName: 'observe_mobile_page',
        phase: 'started',
        round: 1,
      });
    });

    it('renders a "finished" message', () => {
      emitMobileToolStep('sid', 'tap_element', 'finished', 80);
      expect(emitMock).toHaveBeenCalledWith(
        'sid',
        'agent_executing_tool',
        'Tapping element done',
        80,
        expect.objectContaining({ phase: 'finished' }),
      );
    });

    it('renders a "failed" message', () => {
      emitMobileToolStep('sid', 'swipe', 'failed', 80);
      expect(emitMock).toHaveBeenCalledWith(
        'sid',
        'agent_executing_tool',
        'Swiping had an issue',
        80,
        expect.objectContaining({ phase: 'failed' }),
      );
    });
  });
});
