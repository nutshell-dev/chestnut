import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1364: Runtime dialog session boundary', () => {
  it('owner lifecycle exposes exactly the six required operations', () => {
    const types = read('src/foundation/dialog-store/types.ts');
    const store = read('src/foundation/dialog-store/store.ts');
    const barrel = read('src/foundation/dialog-store/index.ts');
    const body = types.match(
      /export interface DialogSessionLifecycle \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body;

    expect(body).toBeDefined();
    expect(body?.match(/^\s*[a-zA-Z][A-Za-z]+\(/gm)).toHaveLength(6);
    for (const member of ['load', 'save', 'beginTurn', 'commitTurn', 'rollbackTurn', 'archive']) {
      expect(body).toContain(`${member}(`);
    }
    expect(store).toContain('export class DialogStore implements DialogSessionLifecycle');
    expect(barrel).toContain('DialogSessionLifecycle');
    expect(barrel).toContain('repairMessages as repairDialogMessages');
  });

  it('Runtime consumes the lifecycle and the owner repair function', () => {
    const types = read('src/core/runtime/types.ts');
    const runtime = read('src/core/runtime/runtime.ts');

    expect(types).toContain('readonly sessionManager: DialogSessionLifecycle');
    expect(types).toContain('readonly dialogStoreFactory: () => DialogSessionLifecycle');
    expect(runtime).toContain('protected sessionManager!: DialogSessionLifecycle');
    expect(runtime).toContain('private dialogStoreFactory!: () => DialogSessionLifecycle');
    expect(runtime).toContain('repairDialogMessages(');
    expect(runtime).not.toMatch(/import \{[^}]*\bDialogStore\b[^}]*\} from '..\/..\/foundation\/dialog-store\/index\.js'/s);
    expect(runtime).not.toMatch(/DialogStore\.repair\(/);
  });

  it('regime switch propagates only the lifecycle protocol', () => {
    const source = read('src/foundation/dialog-store/regime-switch.ts');

    expect(source).toContain('currentStore: DialogSessionLifecycle');
    expect(source).toContain('dialogStoreFactory: () => DialogSessionLifecycle');
    expect(source).toContain('newStore: DialogSessionLifecycle');
    expect(source).not.toMatch(/currentStore: DialogStore|\(\) => DialogStore|newStore: DialogStore/);
  });
});
