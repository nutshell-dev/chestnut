import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createLLMConfigurationDocumentStore,
  getLLMConfigurationPath,
} from '../../src/core/llm-configuration/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

interface Scenario {
  mode: 'before-commit' | 'after-commit';
  barrierDir: string;
  replacementModel: string;
}

const scenarioPath = process.argv[2];
if (!scenarioPath) throw new Error('usage: provider-replace-interruption <scenario.json>');
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as Scenario;
const configPath = getLLMConfigurationPath();
const readyPath = path.join(scenario.barrierDir, 'ready.json');

function publishReady(value: Record<string, unknown>): void {
  const temporary = `${readyPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, readyPath);
}

function interrupt(writeKind?: string): never {
  publishReady({
    pid: process.pid,
    cwd: process.cwd(),
    mode: scenario.mode,
    revisionAtInterruption: createLLMConfigurationDocumentStore({
      fsFactory: (baseDir: string) => new NodeFileSystem({ baseDir }),
    }).readRevision(),
    lockRaw: fs.readFileSync(`${configPath}.lock`, 'utf8'),
    ...(writeKind !== undefined && { writeKind }),
  });
  process.kill(process.pid, 'SIGKILL');
  throw new Error('SIGKILL did not terminate provider replace fixture');
}

const faultDeps = {
  fsFactory: (baseDir: string) => new (class extends NodeFileSystem {
    override writeAtomicSync(relativePath: string, content: string) {
      if (this.resolve(relativePath) !== configPath) {
        return super.writeAtomicSync(relativePath, content);
      }
      if (scenario.mode === 'before-commit') interrupt();
      const actual = super.writeAtomicSync(relativePath, content);
      interrupt(actual.kind);
    }
  })({ baseDir }),
};

try {
  const store = createLLMConfigurationDocumentStore(faultDeps);
  const current = store.read();
  await store.commitExplicitProvider(
    { kind: 'replace', slot: { role: 'primary' } },
    { ...current.primary, model: scenario.replacementModel },
    current.revision,
  );
  throw new Error('provider replace interruption hook was not reached');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
