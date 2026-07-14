import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { chatCommand } from '../../../src/cli/commands/claw-chat.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('claw-chat', () => {
  let tmpDir: string;
  let originalRoot: string | undefined;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('chestnut-chat-test-');
    originalRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tmpDir;

    // Create global config so loadGlobalConfig passes
    const configPath = path.join(tmpDir, '.chestnut', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      'version: "1"\nllm:\n  primary:\n    preset: anthropic\n    api_key: test\n    model: claude\n    max_tokens: 4096\n    temperature: 0.7\n    timeout_ms: 60000\n  retry_attempts: 3\n  retry_delay_ms: 1000\n',
    );
  });

  afterEach(async () => {
    if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = originalRoot;
    await cleanupTempDir(tmpDir);
  });

  it('error msg contains Try guidance hint when claw does not exist (phase 981 E-α2)', async () => {
    await expect(chatCommand({ fsFactory }, 'nonexistent-claw')).rejects.toThrow(/Try `chestnut claw list`/);
  });
});
