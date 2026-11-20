/** @module L1.LLMProvider.InputMeterAsset */

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 32_768;
const MAX_ASSET_OWNERS = 8;

/** Exact text counts are rebuildable performance data, never usage facts. */
export class BoundedInputTextCache {
  private readonly entries = new Map<string, number>();
  private bytes = 0;

  read(text: string): number | undefined {
    const hit = this.entries.get(text);
    if (hit !== undefined) {
      this.entries.delete(text);
      this.entries.set(text, hit);
    }
    return hit;
  }

  write(text: string, count: number): void {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_CACHE_BYTES) return;
    while (this.bytes + bytes > MAX_CACHE_BYTES || this.entries.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.bytes -= Buffer.byteLength(oldest, 'utf8');
      this.entries.delete(oldest);
    }
    this.entries.set(text, count);
    this.bytes += bytes;
  }
}

export interface InputMeterAssetOwner<T> {
  encoder?: T;
  readonly textCache: BoundedInputTextCache;
}

const owners = new Map<string, InputMeterAssetOwner<unknown>>();
const factoryIds = new WeakMap<() => unknown, number>();
let nextFactoryId = 1;

function factoryId(factory: () => unknown): number {
  const existing = factoryIds.get(factory);
  if (existing !== undefined) return existing;
  const id = nextFactoryId;
  nextFactoryId += 1;
  factoryIds.set(factory, id);
  return id;
}

/**
 * Reuse only identical family/asset/projection/factory resources. Descriptors,
 * credentials and configuration generations are deliberately not cache keys.
 */
export function acquireInputMeterAsset<T>(
  profile: string,
  assetRevision: string,
  projectionRevision: string,
  factory: () => T,
): InputMeterAssetOwner<T> {
  const key = `${profile}\0${assetRevision}\0${projectionRevision}\0${factoryId(factory)}`;
  const existing = owners.get(key) as InputMeterAssetOwner<T> | undefined;
  if (existing) {
    owners.delete(key);
    owners.set(key, existing as InputMeterAssetOwner<unknown>);
    return existing;
  }
  const owner: InputMeterAssetOwner<T> = { textCache: new BoundedInputTextCache() };
  if (owners.size >= MAX_ASSET_OWNERS) {
    const oldest = owners.keys().next().value as string | undefined;
    if (oldest !== undefined) owners.delete(oldest);
  }
  owners.set(key, owner as InputMeterAssetOwner<unknown>);
  return owner;
}
