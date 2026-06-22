import { RecordingCaptureService } from '../recording-capture.service';

describe('RecordingCaptureService iframe probing', () => {
  it('probes only the matching iframe by index', async () => {
    const frame0Evaluate = jest.fn().mockResolvedValue(null);
    const frame1Evaluate = jest.fn().mockResolvedValue({
      tag: 'button',
      text: 'Save',
      boundingBox: { x: 5, y: 6, width: 20, height: 10 },
    });

    const mockPage = {
      evaluate: jest
        .fn()
        .mockResolvedValueOnce(null) // main frame probe
        .mockResolvedValueOnce(null) // diagnostic evaluate (post-null probe)
        .mockResolvedValueOnce([
          { index: 0, x: 0, y: 0, width: 100, height: 100 },
          { index: 1, x: 100, y: 0, width: 100, height: 100 },
        ]),
      mainFrame: jest.fn(() => ({
        childFrames: jest.fn(() => [
          { evaluate: frame0Evaluate },
          { evaluate: frame1Evaluate },
        ]),
      })),
    };

    const result = await RecordingCaptureService.probeForRecording(
      mockPage as any,
      120,
      15,
    );

    expect(frame0Evaluate).not.toHaveBeenCalled();
    expect(frame1Evaluate).toHaveBeenCalledTimes(1);
    expect(frame1Evaluate).toHaveBeenCalledWith(expect.stringContaining('(20, 15)'));
    expect(result?.tag).toBe('button');
    // bounding box should be rebased back to viewport coords (+ iframe x/y)
    expect(result?.boundingBox).toEqual({ x: 105, y: 6, width: 20, height: 10 });
  });
});
