import { describe, expect, it, vi } from 'vitest';
import { acquireInputMeterAsset } from '../../../src/foundation/llm-provider/input-meter-asset.js';

describe('input meter process-local assets', () => {
  it('reuses only the same family, asset revision, projection, and factory', () => {
    const factory = vi.fn(() => ({ encode: vi.fn() }));
    const first = acquireInputMeterAsset('phase2212-family', 'asset-a', 'projection-a', factory);
    const same = acquireInputMeterAsset('phase2212-family', 'asset-a', 'projection-a', factory);
    const otherRevision = acquireInputMeterAsset('phase2212-family', 'asset-b', 'projection-a', factory);
    const otherFamily = acquireInputMeterAsset('phase2212-other-family', 'asset-a', 'projection-a', factory);
    const otherProjection = acquireInputMeterAsset('phase2212-family', 'asset-a', 'projection-b', factory);

    expect(same).toBe(first);
    expect(otherRevision).not.toBe(first);
    expect(otherFamily).not.toBe(first);
    expect(otherProjection).not.toBe(first);
  });

  it('shares exact text counts without sharing descriptor or configuration state', () => {
    const factory = () => ({ encode: vi.fn() });
    const first = acquireInputMeterAsset('phase2212-cache', 'asset', 'projection', factory);
    const second = acquireInputMeterAsset('phase2212-cache', 'asset', 'projection', factory);
    const encode = vi.fn(() => 7);

    expect(first.textCache.read('same input')).toBeUndefined();
    first.textCache.write('same input', encode());
    expect(second.textCache.read('same input')).toBe(7);
    expect(encode).toHaveBeenCalledTimes(1);
  });
});
