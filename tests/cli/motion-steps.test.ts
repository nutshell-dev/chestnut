import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { motionStepsCommand, motionStepCommand } from '../../src/cli/commands/motion-steps.js';
import * as clawSteps from '../../src/cli/commands/claw-steps.js';

describe('motion-steps', () => {
  let clawStepsSpy: ReturnType<typeof vi.spyOn>;
  let clawStepSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clawStepsSpy = vi.spyOn(clawSteps, 'clawStepsCommand').mockResolvedValue(undefined);
    clawStepSpy = vi.spyOn(clawSteps, 'clawStepCommand').mockResolvedValue(undefined);
  });

  afterEach(() => {
    clawStepsSpy.mockRestore();
    clawStepSpy.mockRestore();
  });

  it('motionStepsCommand 等价 clawStepsCommand("motion")', async () => {
    await motionStepsCommand();
    expect(clawStepsSpy).toHaveBeenCalledWith('motion');
    expect(clawStepsSpy).toHaveBeenCalledTimes(1);
  });

  it('motionStepCommand("1") 等价 clawStepCommand("1", "motion")', async () => {
    await motionStepCommand('1');
    expect(clawStepSpy).toHaveBeenCalledWith('1', 'motion');
    expect(clawStepSpy).toHaveBeenCalledTimes(1);
  });
});
