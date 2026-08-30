import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sendSource = readFileSync(
  new URL('../../../src/foundation/messaging/tools/send.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/messaging/index.ts', import.meta.url),
  'utf8',
);

describe('Messaging SEND_TOOL_NAME deep surface', () => {
  it('keeps the send tool name constant local behind createSendTool', () => {
    expect(sendSource).not.toMatch(/export\s+const\s+SEND_TOOL_NAME\b/);
    expect(sendSource).toMatch(
      /(?:^|\n)const\s+SEND_TOOL_NAME\s*=\s*'send'\s+as\s+const;/,
    );
    expect(sendSource).toMatch(/(?:^|\n)\s*name:\s*SEND_TOOL_NAME,/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bcreateSendTool\b[^}]*\}\s*from\s*'\.\/tools\/send\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bSEND_TOOL_NAME\b/);
  });
});
