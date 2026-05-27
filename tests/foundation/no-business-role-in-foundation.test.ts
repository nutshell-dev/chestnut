import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import path from 'node:path';

const BUSINESS_ROLES = ['motion', 'claw', 'subagent', 'verifier', 'shadow', 'miner'];

// Pre-existing literals outside the 3-site scope of phase1254.
// These are tool-profile names / messaging defaults / config schemas,
// not caller-role definitions. They are recorded as technical debt
// for future phase r134+ assessment.
const ALLOW_LIST_FILES = new Set([
  'src/foundation/command-tool/exec.ts',
  'src/foundation/config/schemas.ts',
  'src/foundation/file-tool/edit.ts',
  'src/foundation/file-tool/ls.ts',
  'src/foundation/file-tool/multi_edit.ts',
  'src/foundation/file-tool/read.ts',
  'src/foundation/file-tool/search.ts',
  'src/foundation/file-tool/write.ts',
  'src/foundation/messaging/tools/notify-claw.ts',
  'src/foundation/messaging/tools/send.ts',
  'src/foundation/process-manager/agent-factory.ts',
  'src/foundation/process-manager/types.ts',
  'src/foundation/skill-system/tools/skill.ts',
  'src/foundation/tools/context.ts',
  'src/foundation/tools/executor.ts',
  'src/foundation/tools/types.ts',
]);

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else if (p.endsWith('.ts')) files.push(p);
  }
  return files;
}

describe('foundation/ 域 ML#5 invariant: no business caller role literal', () => {
  it('foundation/paths.ts + tool-protocol/ 不持 quoted business role literal', () => {
    const targetFiles = [
      'src/foundation/paths.ts',
      'src/foundation/tool-protocol/index.ts',
    ];
    for (const file of targetFiles) {
      const src = readFileSync(file, 'utf-8');
      for (const role of BUSINESS_ROLES) {
        const pattern = new RegExp(`['"\`]${role}['"\`]`);
        const m = src.match(pattern);
        if (m) {
          expect.fail(`foundation/ 持 business role literal '${role}' in ${file}: ${m[0]}`);
        }
      }
    }
  });

  it('foundation/tool-protocol/index.ts 不 re-export CallerType', () => {
    const src = readFileSync('src/foundation/tool-protocol/index.ts', 'utf-8');
    expect(src).not.toMatch(/export.*CallerType/);
    expect(src).not.toMatch(/export.*DispatchCallerType/);
    expect(src).not.toMatch(/export.*callerTypeToProfile/);
  });

  it('foundation/ 不 import from src/core/ (except caller-types migration)', () => {
    const files = walk('src/foundation');
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      const coreImports = src.match(/from\s+['"][^'"]*\/core\/[^'"]*['"]/g);
      if (coreImports) {
        const nonAllowed = coreImports.filter(
          (imp) => !imp.includes('caller-types')
        );
        if (nonAllowed.length > 0) {
          expect.fail(`${file} 不该 import from core/ (non-allowed: ${nonAllowed.join(', ')})`);
        }
      }
    }
  });

  it('foundation/ 无 NEW quoted business role literal (allow-list pre-existing)', () => {
    const files = walk('src/foundation').filter(f => !ALLOW_LIST_FILES.has(f));
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      for (const role of BUSINESS_ROLES) {
        const pattern = new RegExp(`['"\`]${role}['"\`]`);
        const m = src.match(pattern);
        if (m) {
          expect.fail(`foundation/ NEW business role literal '${role}' in ${file}: ${m[0]}`);
        }
      }
    }
  });
});
