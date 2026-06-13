import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noConsoleInBusinessPath from '../../../.config/eslint-rules/no-console-in-business-path.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-console-in-business-path (phase 340)', () => {
  ruleTester.run('no-console-in-business-path', noConsoleInBusinessPath, {
    valid: [
      // out of src/
      { code: 'console.log("ok");', filename: 'tests/foo.test.ts' },
      // allowlist: cli/**
      { code: 'console.log("hello");', filename: 'src/cli/commands/init.ts' },
      // allowlist: watchdog/**
      { code: 'console.warn("warn");', filename: 'src/watchdog/watchdog-cli.ts' },
      // allowlist: foundation/audit/**
      { code: 'console.error("err");', filename: 'src/foundation/audit/writer.ts' },
      // allowlist: daemon-entry.ts
      { code: 'console.log("entry");', filename: 'src/daemon-entry.ts' },
      // allowlist: watchdog-entry.ts
      { code: 'console.log("entry");', filename: 'src/watchdog-entry.ts' },
      // allowlist: assembly/llm-audit-sink.ts
      { code: 'console.error("sink");', filename: 'src/assembly/llm-audit-sink.ts' },
      // business path with `// console: <reason>` exemption
      {
        code: 'console.error("hot"); // console: tmp debug',
        filename: 'src/core/runtime/runtime.ts',
      },
      // business path with `[AUDIT CRITICAL]` marker
      {
        code: 'console.error(`[AUDIT CRITICAL] task cancel nested throw`);',
        filename: 'src/core/async-task-system/system.ts',
      },
      // non-console.* call
      { code: 'logger.info("ok");', filename: 'src/core/runtime/runtime.ts' },
    ],
    invalid: [
      // business path console.log without exemption
      {
        code: 'console.log("debug");',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'consoleInBusinessPath' }],
      },
      // business path console.warn
      {
        code: 'console.warn("test");',
        filename: 'src/foundation/messaging/inbox-writer.ts',
        errors: [{ messageId: 'consoleInBusinessPath' }],
      },
      // business path console.error without [AUDIT CRITICAL] or exemption
      {
        code: 'console.error("plain err");',
        filename: 'src/core/contract/manager.ts',
        errors: [{ messageId: 'consoleInBusinessPath' }],
      },
      // business path console.debug
      {
        code: 'console.debug("d");',
        filename: 'src/core/memory/random-dream.ts',
        errors: [{ messageId: 'consoleInBusinessPath' }],
      },
    ],
  });

  it('rule loaded', () => {});
});
