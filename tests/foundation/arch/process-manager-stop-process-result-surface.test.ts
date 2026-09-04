import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stopSource = readFileSync(
  new URL('../../../src/foundation/process-manager/stop.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/process-manager/index.ts', import.meta.url),
  'utf8',
);

describe('ProcessManager StopProcessOutcome deep surface (ratchet phase 1774)', () => {
  it('keeps StopProcessOutcome as the only public stop result protocol', () => {
    // phase 1769/1774: 唯一公开协议是 types.ts 的 StopProcessOutcome；stop.ts 不得自建
    // 本地结果类型（旧本地 StopProcessResult 已退役，禁止以 alias 复活）
    expect(stopSource).not.toMatch(/export\s+type\s+StopProcess(Result|Outcome)\b/);
    expect(stopSource).not.toMatch(/(?:^|\n)type\s+StopProcessResult\s*=/);
    expect(stopSource).toMatch(/import\s+type\s*\{\s*[^}]*\bStopProcessOutcome\b[^}]*\}\s+from\s+'\.\/types\.js'/);
    expect(stopSource).toMatch(/export\s+async\s+function\s+stopProcess\(/);
    expect(stopSource).toMatch(/Promise<StopProcessOutcome>/);
    expect(stopSource).toMatch(/shouldAbortSpawningForStop/);
    // barrel 公开 StopProcessOutcome、不得回引退役名
    expect(barrelSource).toMatch(/\bStopProcessOutcome\b/);
    expect(barrelSource).not.toMatch(/\bStopProcessResult\b/);
  });
});
