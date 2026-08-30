import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const errorsSource = readFileSync(
  new URL('../../../src/foundation/dialog-store/errors.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/dialog-store/index.ts', import.meta.url),
  'utf8',
);

describe('DialogStore DialogStoreErrorCode deep surface', () => {
  it('keeps the error code type local behind DialogStoreError', () => {
    expect(errorsSource).not.toMatch(/export\s+type\s+DialogStoreErrorCode\b/);
    expect(errorsSource).toMatch(
      /(?:^|\n)type\s+DialogStoreErrorCode\s*=\s*'DIALOG_STORE_ERROR';/,
    );
    expect(errorsSource).toMatch(
      /readonly\s+code:\s*DialogStoreErrorCode\s*=\s*'DIALOG_STORE_ERROR';/,
    );
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bDialogIOError\b[^}]*\}\s*from\s*'\.\/errors\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bDialogStoreErrorCode\b/);
  });
});
