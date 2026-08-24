import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string): string => readFileSync(
  new URL(relativePath, import.meta.url),
  'utf8',
);

const barrelSource = readSource('../../../src/foundation/fs/index.ts');
const atomicSource = readSource('../../../src/foundation/fs/atomic.ts');
const nodeFsSource = readSource('../../../src/foundation/fs/node-fs.ts');
const eventCollectorSource = readSource('../../../src/core/contract/jobs/event-collector.ts');

describe('FileSystem stat instance boundary', () => {
  it('keeps bare stat internal and routes the external caller through FileSystem', () => {
    expect(barrelSource).not.toMatch(/\bstat\b/);
    expect(eventCollectorSource).not.toMatch(
      /import\s*\{[^}]*\bstat\b[^}]*\}\s*from\s*['"][^'"]*foundation\/fs\/index\.js['"]/,
    );
    expect(eventCollectorSource).not.toMatch(/await\s+stat\(progressPath\)/);
    expect(eventCollectorSource).toMatch(/await\s+fs\.stat\(progressPath\)/);
    expect(atomicSource).toMatch(/export\s+async\s+function\s+stat\s*\(/);
    expect(nodeFsSource).toMatch(/import\s*\{[\s\S]*?\bstat\b[\s\S]*?\}\s*from\s*['"]\.\/atomic\.js['"]/);
  });
});
