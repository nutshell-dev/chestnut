import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noSubagentEnsureDirWorkspace from '../../../.config/eslint-rules/no-subagent-ensuredir-workspace.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-subagent-ensuredir-workspace (phase 402)', () => {
  ruleTester.run('no-subagent-ensuredir-workspace', noSubagentEnsureDirWorkspace, {
    valid: [
      // out of scope: not src/core/subagent/
      {
        code: 'ensureDir(workspaceDir);',
        filename: 'src/core/runtime/runtime.ts',
      },
      // out of scope: tests/
      {
        code: 'ensureDir(workspaceDir);',
        filename: 'tests/foo.test.ts',
      },
      // in scope but resultDir (allowed)
      {
        code: 'ensureDir(resultDir);',
        filename: 'src/core/subagent/run.ts',
      },
      // mkdir for unrelated target
      {
        code: 'mkdirSync(taskDir, { recursive: true });',
        filename: 'src/core/subagent/agent.ts',
      },
      // unrelated function call
      {
        code: 'writeFile(workspaceDir, "x");',
        filename: 'src/core/subagent/agent.ts',
      },
      // .d.ts skip
      {
        code: 'ensureDir(workspaceDir);',
        filename: 'src/core/subagent/types.d.ts',
      },
    ],
    invalid: [
      // ensureDir(workspaceDir)
      {
        code: 'ensureDir(workspaceDir);',
        filename: 'src/core/subagent/agent.ts',
        errors: [{ messageId: 'subagentEnsureDirWorkspace' }],
      },
      // mkdirSync(workspacePath)
      {
        code: 'mkdirSync(workspacePath, { recursive: true });',
        filename: 'src/core/subagent/run.ts',
        errors: [{ messageId: 'subagentEnsureDirWorkspace' }],
      },
      // fs.mkdir(CLAWSPACE)
      {
        code: 'fs.mkdir(CLAWSPACE);',
        filename: 'src/core/subagent/agent.ts',
        errors: [{ messageId: 'subagentEnsureDirWorkspace' }],
      },
      // path.join with workspace
      {
        code: 'ensureDir(path.join(root, "workspace"));',
        filename: 'src/core/subagent/agent.ts',
        errors: [{ messageId: 'subagentEnsureDirWorkspace' }],
      },
      // case-insensitive
      {
        code: 'ensureDir(Workspace);',
        filename: 'src/core/subagent/agent.ts',
        errors: [{ messageId: 'subagentEnsureDirWorkspace' }],
      },
    ],
  });

  it('rule loaded', () => {});
});
