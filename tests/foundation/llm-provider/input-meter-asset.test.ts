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
    const otherFactory = vi.fn(() => ({ encode: vi.fn() }));
    const differentFactory = acquireInputMeterAsset('phase2212-family', 'asset-a', 'projection-a', otherFactory);

    expect(same).toBe(first);
    expect(otherRevision).not.toBe(first);
    expect(otherFamily).not.toBe(first);
    expect(otherProjection).not.toBe(first);
    expect(differentFactory).not.toBe(first);
    expect(factory).not.toHaveBeenCalled();
    expect(otherFactory).not.toHaveBeenCalled();
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

    const otherFactory = () => ({ encode: vi.fn() });
    const isolated = [
      acquireInputMeterAsset('phase2212-cache', 'other-asset', 'projection', factory),
      acquireInputMeterAsset('phase2212-other-cache', 'asset', 'projection', factory),
      acquireInputMeterAsset('phase2212-cache', 'asset', 'other-projection', factory),
      acquireInputMeterAsset('phase2212-cache', 'asset', 'projection', otherFactory),
    ];
    expect(isolated.every(owner => owner.textCache.read('same input') === undefined)).toBe(true);
  });
});
