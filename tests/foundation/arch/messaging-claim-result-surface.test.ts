import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const outboxReaderSource = readFileSync(
  new URL('../../../src/foundation/messaging/outbox-reader.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/messaging/index.ts', import.meta.url),
  'utf8',
);

describe('Messaging ClaimResult deep surface', () => {
  it('keeps the claim result type local behind OutboxReader', () => {
    expect(outboxReaderSource).not.toMatch(/export\s+type\s+ClaimResult\b/);
    expect(outboxReaderSource).toMatch(
      /(?:^|\n)type\s+ClaimResult\s*=\s*\|\s*\{\s*status:\s*'empty'\s*\}\s*\|\s*\{\s*status:\s*'race_lost';\s*error:\s*string\s*\}\s*\|\s*\{\s*status:\s*'io_error';\s*error:\s*string\s*\}\s*\|\s*\{\s*status:\s*'claimed';\s*claimPath:\s*string;\s*filename:\s*string;\s*content:\s*string\s*\};/,
    );
    // phase 1755: claimNext 公共签名含可选 opts（phase 1748 skip 能力的 readContent 开关），
    // 默认参数 = {} 保持无 opts 调用点（drain）零改动；ClaimResult 本身仍不导出。
    expect(outboxReaderSource).toMatch(
      /async\s+claimNext\(\s*clawDir:\s*string,\s*opts:\s*\{\s*readContent\?:\s*boolean\s*\}\s*=\s*\{\},\s*\):\s*Promise<ClaimResult>\s*\{/,
    );
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bOutboxReader\b[^}]*\}\s*from\s*'\.\/outbox-reader\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bClaimResult\b/);
  });
});
