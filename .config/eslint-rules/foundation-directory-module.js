/**
 * Custom ESLint rule: foundation-directory-module
 *
 * 应然：src/foundation/ 目录布局必须与已注册模块及 @module 标签保持一致。
 *
 * 约束 src/foundation/ 目录结构：
 * 1. foundation/ 根不允许 .ts 文件
 * 2. 每个子目录必须对应一个已注册模块
 * 3. 子目录内文件如有 @module，必须匹配该目录的模块（允许子后缀）
 *
 * Phase 717
 */

const DIRECTORY_MODULES = new Map([
  ['audit', 'L2a.AuditLog'],
  ['claw-identity', 'L2c.ClawIdentity'],
  ['command-tool', 'L2c.CommandTool'],
  ['cron', 'L2a.Cron'],
  ['dialog-store', 'L2b.DialogStore'],
  ['file-tool', 'L2c.FileTool'],
  ['file-watcher', 'L1.FileWatcher'],
  ['fs', 'L1.FileSystem'],
  ['llm-orchestrator', 'L2b.LLMOrchestrator'],
  ['llm-provider', 'L1.LLMProvider'],
  ['messaging', 'L2c.Messaging'],
  ['node-utils', 'L1.NodeUtils'],
  ['process-exec', 'L1.ProcessExec'],
  ['process-manager', 'L2a.ProcessManager'],
  ['skill-system', 'L2c.SkillSystem'],
  ['snapshot', 'L2a.Snapshot'],
  ['stream', 'L2b.Stream'],
  ['tool-protocol', 'L2b.ToolProtocol'],
  ['tools', 'L2c.Tools'],
  ['transport', 'L1.Transport'],
]);

const MODULE_TAG_RE = /[*]\s*@module\s+([A-Za-z0-9_.]+)/;

function basenameOf(filepath) {
  const idx = filepath.lastIndexOf('/');
  return idx === -1 ? filepath : filepath.slice(idx + 1);
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'src/foundation/ directory layout must match registered modules and @module tags (phase 717)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      noRootFiles:
        'foundation/ root forbids standalone .ts files (only subdirectories): `{{file}}`',
      unknownDirectory:
        'foundation/{{dir}}/ is not a registered module directory: `{{file}}`',
      moduleMismatch:
        '@module in `{{file}}` is `{{actual}}`, expected `{{expected}}` or a sub-suffix',
    },
  },

  create(context) {
    const filename = context.filename || '';
    const foundationIdx = filename.lastIndexOf('/src/foundation/');
    if (foundationIdx === -1) return {};

    const rel = filename.slice(foundationIdx + '/src/foundation/'.length);
    const parts = rel.split('/');
    const base = basenameOf(filename);

    // Rule 1: no standalone .ts files at foundation/ root
    if (parts.length === 1 && parts[0].endsWith('.ts')) {
      return {
        Program(node) {
          context.report({
            node,
            messageId: 'noRootFiles',
            data: { file: base },
          });
        },
      };
    }

    const dir = parts[0];
    const expectedModule = DIRECTORY_MODULES.get(dir);

    // Rule 2: every subdirectory must be registered
    if (!expectedModule) {
      return {
        Program(node) {
          context.report({
            node,
            messageId: 'unknownDirectory',
            data: { dir, file: base },
          });
        },
      };
    }

    // Rule 3: validate the first @module tag matches the directory's module
    return {
      Program(node) {
        const sourceCode = context.sourceCode || context.getSourceCode();
        const text = sourceCode.getText();
        const match = MODULE_TAG_RE.exec(text);
        if (!match) return;

        const actualModule = match[1];
        if (
          actualModule === expectedModule ||
          actualModule.startsWith(`${expectedModule}.`)
        ) {
          return;
        }

        context.report({
          node,
          messageId: 'moduleMismatch',
          data: {
            file: base,
            actual: actualModule,
            expected: expectedModule,
          },
        });
      },
    };
  },
};
