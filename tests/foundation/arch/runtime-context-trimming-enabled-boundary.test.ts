import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('Runtime trim enablement boundary (phase 1505)', () => {
  it('Runtime owns an explicit boolean enablement option', () => {
    expect(read('src/core/runtime/types.ts')).toContain('contextTrimmingEnabled?: boolean');
    expect(read('src/core/runtime/runtime.ts')).toContain('this.contextTrimmingEnabled = options.contextTrimmingEnabled ?? false');
  });

  it('Assembly explicitly enables trimming on the production path', () => {
    expect(read('src/assembly/runtime-assembly.ts')).toContain('contextTrimmingEnabled: true');
  });

  it('StepExecutor does not own the retired Runtime config marker', () => {
    expect(read('src/core/step-executor/types.ts')).not.toContain('ContextManagerRuntimeConfig');
    expect(read('src/core/step-executor/index.ts')).not.toContain('ContextManagerRuntimeConfig');
  });
});
