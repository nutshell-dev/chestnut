import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { TaskExecutionPort } from '../../src/core/async-task-system/index.js';
import type {
  SubagentExecutionInfrastructure,
  SubagentExecutionRunner,
} from '../../src/core/subagent/index.js';
import { createDefaultSubagentExecutionRunner } from '../../src/core/subagent/index.js';
import type { SpawnSubagentRunner } from '../../src/core/spawn-system/system.js';
import type { ShadowSubagentRunner } from '../../src/core/shadow-system/system.js';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('Phase 2248 I: production SubAgent execution binding', () => {
  it('the real shared runner structurally satisfies ATS and synchronous consumer ports', () => {
    expectTypeOf<SubagentExecutionRunner>().toMatchTypeOf<TaskExecutionPort>();
    expectTypeOf<SubagentExecutionRunner>().toMatchTypeOf<SpawnSubagentRunner>();
    expectTypeOf<SubagentExecutionRunner>().toMatchTypeOf<ShadowSubagentRunner>();
    expectTypeOf<ReturnType<typeof createDefaultSubagentExecutionRunner>>()
      .toEqualTypeOf<SubagentExecutionRunner>();
    expectTypeOf<SubagentExecutionInfrastructure>().not.toHaveProperty('agentId');
    expectTypeOf<SubagentExecutionInfrastructure>().not.toHaveProperty('resultDir');
  });

  it('Assembly constructs one owner and binds that same capability to ATS and Spawn/Shadow', () => {
    const business = read('src/assembly/business-systems.ts');
    expect(business.match(/createDefaultSubagentExecutionRunner\(\{/g)).toHaveLength(1);
    expect(business).toContain('const execution: TaskExecutionPort = subagentRunner;');
    expect(business).toContain('execution,');
    expect(business).toContain('sharedRecovery: llm,');
    expect(business).toContain('prepareLegacyInput: prepareBoundSubagentInput,');
    expect(business).toMatch(/createSpawnTool\(\{[\s\S]*?subagentRunner,[\s\S]*?\}\)/);

    const runtime = read('src/assembly/runtime-assembly.ts');
    expect(runtime).toContain('prepareTaskExecutionInputs: () => migrateShadowTaskInputs(taskSystem),');
    expect(runtime).toMatch(/createShadowTool\(\{[\s\S]*?subagentRunner,[\s\S]*?\}\)/);
    expect(fs.existsSync(path.join(process.cwd(), 'src/assembly/subagent-task-executor.ts'))).toBe(false);
  });

  it('Runtime owns initialize → owner migration → dispatch without payload interpretation', () => {
    const runtime = read('src/core/runtime/runtime.ts');
    const initialize = runtime.indexOf('await this.taskSystem.initialize();');
    const prepare = runtime.indexOf('await deps.prepareTaskExecutionInputs();');
    const dispatch = runtime.indexOf('await this.taskSystem.startDispatch();');
    expect(initialize).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeGreaterThan(initialize);
    expect(dispatch).toBeGreaterThan(prepare);
    expect(runtime).not.toContain('executorPayload');
  });
});
