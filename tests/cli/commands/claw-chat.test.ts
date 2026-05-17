import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { chatCommand } from '../../../src/cli/commands/claw-chat.js';

describe('claw-chat', () => {
  let tmpDir: string;
  let originalRoot: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawforum-chat-test-'));
    originalRoot = process.env.CLAWFORUM_ROOT;
    process.env.CLAWFORUM_ROOT = tmpDir;

    // Create global config so loadGlobalConfig passes
    const configPath = path.join(tmpDir, '.clawforum', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      'version: "1"\nllm:\n  primary:\n    preset: anthropic\n    api_key: test\n    model: claude\n    max_tokens: 4096\n    temperature: 0.7\n    timeout_ms: 60000\n  retry_attempts: 3\n  retry_delay_ms: 1000\n',
    );
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.CLAWFORUM_ROOT;
    else process.env.CLAWFORUM_ROOT = originalRoot;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('error msg contains Try guidance hint when claw does not exist (phase 981 E-α2)', async () => {
    await expect(chatCommand('nonexistent-claw')).rejects.toThrow(/Try `clawforum claw list`/);
  });
});
