import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1366: task stream binding ownership boundary', () => {
  it('Assembly owns the stream binding at construction (phase 1872 Step F: 构造参数一次固定)', () => {
    const business = read('src/assembly/business-systems.ts');
    const runtimeAssembly = read('src/assembly/runtime-assembly.ts');

    // 绑定经 ATS 工厂构造参数（不再经后补 setter）
    expect(business).toContain('parentStreamLog: streamWriter');
    expect(runtimeAssembly).not.toContain('setParentStreamLog(');
    expect(business).not.toContain('setParentStreamLog(');
  });

  it('Runtime neither declares nor performs task stream binding', () => {
    const types = read('src/core/runtime/types.ts');
    const runtime = read('src/core/runtime/runtime.ts');

    expect(types).not.toContain('parentStreamLog');
    expect(runtime).not.toContain('parentStreamLog');
    expect(runtime).not.toContain('.setParentStreamLog(');
  });

  it('the owner API fixes the binding at construction (setter 退役)', () => {
    const system = read('src/core/async-task-system/system.ts');
    const types = read('src/core/async-task-system/types.ts');
    const lifecycle = types.match(/export interface AsyncTaskRuntimeLifecycle \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

    // phase 1872 Step F：post-ctor setter 退役；parentStreamLog 归构造 options。
    expect(system).not.toContain('setParentStreamLog(');
    expect(types).toContain('parentStreamLog?: StreamLog');
    expect(lifecycle).toBeDefined();
    expect(lifecycle).not.toContain('setParentStreamLog');
  });
});
