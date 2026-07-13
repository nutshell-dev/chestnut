import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import noInlineError from './eslint-rules/no-inline-error-pattern.js';
import noStringSniffError from './eslint-rules/no-string-sniff-error.js';
import noDirectProcessExitInCli from './eslint-rules/no-direct-process-exit-in-cli.js';
import noDirectErrnoCodeCompare from './eslint-rules/no-direct-errno-code-compare.js';
import noHardcodedInboxPath from './eslint-rules/no-hardcoded-inbox-path.js';
import noDirectFsWriteatomicToInbox from './eslint-rules/no-direct-fs-writeatomic-to-inbox.js';
import noPermManagementInCommandTool from './eslint-rules/no-perm-management-in-command-tool.js';
import noClawdirPathAntiPattern from './eslint-rules/no-clawdir-path-anti-pattern.js';
import noStringAnchorChestnut from './eslint-rules/no-string-anchor-chestnut.js';
import noDeriveChestnutRoot from './eslint-rules/no-derive-chestnut-root.js';
import formatterParityRequireConstants from './eslint-rules/formatter-parity-require-constants.js';
import foundationNoBusinessRoleLiteral from './eslint-rules/foundation-no-business-role-literal.js';
import auditCapConstScope from './eslint-rules/audit-cap-const-scope.js';
import foundationNoCliVerbFact from './eslint-rules/foundation-no-cli-verb-fact.js';
import noMotionLiteralInSrc from './eslint-rules/no-motion-literal-in-src.js';
import noConsoleInBusinessPath from './eslint-rules/no-console-in-business-path.js';
import noSilentCatchOutsideAllowlist from './eslint-rules/no-silent-catch-outside-allowlist.js';
import noSilentXWithoutAllowedPattern from './eslint-rules/no-silent-x-without-allowed-pattern.js';
import noRuntimeCurrentStateGetter from './eslint-rules/no-runtime-current-state-getter.js';
import noClawsEnumerationFanout from './eslint-rules/no-claws-enumeration-fanout.js';
import noDirectNewNodeFileSystem from './eslint-rules/no-direct-new-nodefilesystem.js';
import noClawBusinessLiteral from './eslint-rules/no-claw-business-literal.js';
import noChatMethod from './eslint-rules/no-chat-method.js';
import noChestnutDirNaming from './eslint-rules/no-chestnut-dir-naming.js';
import noFilenameTag from './eslint-rules/no-filename-tag.js';
import noRuntimeKnowsUpperLayer from './eslint-rules/no-runtime-knows-upper-layer-messages.js';
import noSubagentEnsureDirWorkspace from './eslint-rules/no-subagent-ensuredir-workspace.js';
import execContextFieldBudget from './eslint-rules/exec-context-field-budget.js';
import noEntryLiteralOutsideAllowlist from './eslint-rules/no-entry-literal-outside-allowlist.js';
import noCronHandlerWithoutSignal from './eslint-rules/no-cron-handler-without-signal.js';
import typedEmitCascadeFirstLineGuard from './eslint-rules/typed-emit-cascade-first-line-guard.js';
import foundationDirectoryModule from './eslint-rules/foundation-directory-module.js';
import noBareTempdirInTests from './eslint-rules/no-bare-tempdir-in-tests.js';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'chestnut-custom': {
        rules: {
          'no-inline-error-pattern': noInlineError,
          'no-string-sniff-error': noStringSniffError,
          'no-direct-process-exit-in-cli': noDirectProcessExitInCli,
          'no-direct-errno-code-compare': noDirectErrnoCodeCompare,
          'no-hardcoded-inbox-path': noHardcodedInboxPath,
          'no-direct-fs-writeatomic-to-inbox': noDirectFsWriteatomicToInbox,
          'no-perm-management-in-command-tool': noPermManagementInCommandTool,
          'no-clawdir-path-anti-pattern': noClawdirPathAntiPattern,
          'no-string-anchor-chestnut': noStringAnchorChestnut,
          'no-derive-chestnut-root': noDeriveChestnutRoot,
          'formatter-parity-require-constants': formatterParityRequireConstants,
          'foundation-no-business-role-literal': foundationNoBusinessRoleLiteral,
          'audit-cap-const-scope': auditCapConstScope,
          'foundation-no-cli-verb-fact': foundationNoCliVerbFact,
          'no-motion-literal-in-src': noMotionLiteralInSrc,
          'no-console-in-business-path': noConsoleInBusinessPath,
          'no-silent-catch-outside-allowlist': noSilentCatchOutsideAllowlist,
          'no-silent-x-without-allowed-pattern': noSilentXWithoutAllowedPattern,
          'no-runtime-current-state-getter': noRuntimeCurrentStateGetter,
          'no-claws-enumeration-fanout': noClawsEnumerationFanout,
          'no-direct-new-nodefilesystem': noDirectNewNodeFileSystem,
          'no-claw-business-literal': noClawBusinessLiteral,
          'no-chat-method': noChatMethod,
          'no-chestnut-dir-naming': noChestnutDirNaming,
          'no-filename-tag': noFilenameTag,
          'no-runtime-knows-upper-layer-messages': noRuntimeKnowsUpperLayer,
          'no-subagent-ensuredir-workspace': noSubagentEnsureDirWorkspace,
          'exec-context-field-budget': execContextFieldBudget,
          'no-entry-literal-outside-allowlist': noEntryLiteralOutsideAllowlist,
          'no-cron-handler-without-signal': noCronHandlerWithoutSignal,
          'typed-emit-cascade-first-line-guard': typedEmitCascadeFirstLineGuard,
          'foundation-directory-module': foundationDirectoryModule,
        },
      },
    },
    rules: {
      // Minimal severity baseline: avoid noise during infra phase.
      // Recommended typescript-eslint rules are disabled to keep baseline lint clean.
      // Custom rules are enforced.
      'chestnut-custom/no-inline-error-pattern': 'error',
      'chestnut-custom/no-string-sniff-error': 'error',
      'chestnut-custom/no-direct-process-exit-in-cli': 'error',
      'chestnut-custom/no-direct-errno-code-compare': 'error',
      'chestnut-custom/no-hardcoded-inbox-path': 'error',
      'chestnut-custom/no-direct-fs-writeatomic-to-inbox': 'error',
      'chestnut-custom/no-perm-management-in-command-tool': 'error',
      'chestnut-custom/no-clawdir-path-anti-pattern': 'error',
      'chestnut-custom/no-string-anchor-chestnut': 'error',
      'chestnut-custom/no-derive-chestnut-root': 'error',
      'chestnut-custom/formatter-parity-require-constants': 'error',
      'chestnut-custom/foundation-no-business-role-literal': 'error',
      'chestnut-custom/audit-cap-const-scope': 'error',
      'chestnut-custom/foundation-no-cli-verb-fact': 'error',
      'chestnut-custom/no-motion-literal-in-src': 'error',
      'chestnut-custom/no-console-in-business-path': 'error',
      'chestnut-custom/no-silent-catch-outside-allowlist': 'error',
      'chestnut-custom/no-silent-x-without-allowed-pattern': 'error',
      'chestnut-custom/no-runtime-current-state-getter': 'error',
      'chestnut-custom/no-claws-enumeration-fanout': 'error',
      'chestnut-custom/no-direct-new-nodefilesystem': 'error',
      'chestnut-custom/no-claw-business-literal': 'error',
      'chestnut-custom/no-chat-method': 'error',
      'chestnut-custom/no-chestnut-dir-naming': 'error',
      'chestnut-custom/no-filename-tag': 'error',
      'chestnut-custom/no-runtime-knows-upper-layer-messages': 'error',
      'chestnut-custom/no-subagent-ensuredir-workspace': 'error',
      'chestnut-custom/exec-context-field-budget': 'error',
      'chestnut-custom/no-entry-literal-outside-allowlist': 'error',
      'chestnut-custom/no-cron-handler-without-signal': 'error',
      'chestnut-custom/typed-emit-cascade-first-line-guard': 'error',
      'chestnut-custom/foundation-directory-module': 'error',
    },
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'chestnut-custom': {
        rules: {
          'no-bare-tempdir-in-tests': noBareTempdirInTests,
        },
      },
    },
    rules: {
      'chestnut-custom/no-bare-tempdir-in-tests': 'error',
    },
  },
];
