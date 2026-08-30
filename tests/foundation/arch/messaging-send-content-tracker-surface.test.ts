import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const extractorSource = readFileSync(
  new URL('../../../src/foundation/messaging/tools/send-content-extractor.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/messaging/index.ts', import.meta.url),
  'utf8',
);

describe('Messaging SendContentTracker deep surface', () => {
  it('keeps the tracker interface local behind create/feed', () => {
    expect(extractorSource).not.toMatch(/export\s+interface\s+SendContentTracker\s*\{/);
    expect(extractorSource).toMatch(
      /(?:^|\n)interface\s+SendContentTracker\s*\{[\s\S]*?\binContent:\s*boolean;[\s\S]*?\bcontentStart:\s*number;[\s\S]*?\bemitted:\s*number;[\s\S]*?\bbuffer:\s*string;[\s\S]*?\}/,
    );
    expect(extractorSource).toMatch(
      /export\s+function\s+createSendContentTracker\(\):\s*SendContentTracker\s*\{/,
    );
    expect(extractorSource).toMatch(
      /export\s+function\s+feedSendContentDelta\(\s*tracker:\s*SendContentTracker,/,
    );
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bcreateSendContentTracker\b[^}]*\bfeedSendContentDelta\b[^}]*\}\s*from\s*'\.\/tools\/send-content-extractor\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bSendContentTracker\b/);
  });
});
