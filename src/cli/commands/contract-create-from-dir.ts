/**
 * Create a contract from a directory containing contract.yaml + verification/
 */

import * as path from 'path';
import { resolveChestnutRoot } from '../../core/claw-topology/index.js';
import { CONTRACT_YAML_FILE, getContractVerificationDir } from '../../core/contract/index.js';
import type { ContractSystem } from '../../core/contract/index.js';
import { ContractCreatePolicyViolationError } from '../../core/contract/types.js';
import { getClawDir } from '../../core/claw-topology/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { makeContractId } from '../../core/contract/types.js';
import { parseAndValidateContractYaml, notifyContractCreated } from './contract-helpers.js';
import { CliError } from '../errors.js';

// phase 324 H10: 拷贝硬化常量。
const COPY_ALLOWED_EXTENSIONS = new Set(['.sh', '.md', '.txt', '.json', '.yaml', '.yml']);

/**
 * contract dir copy 单 file 大小上限（默 1 MB）.
 * Derivation: 1 * 1024 * 1024 = 1_048_576 byte / 覆盖典型 contract template (.sh/.md/.yaml 等) 平均 < 10KB /
 * 1MB 留足极大 spec 余量 / env CHESTNUT_CONTRACT_DIR_COPY_MAX_BYTES 覆盖.
 */
const COPY_MAX_FILE_BYTES_DEFAULT = 1 * 1024 * 1024;
function getCopyMaxFileBytes(): number {
  const raw = process.env.CHESTNUT_CONTRACT_DIR_COPY_MAX_BYTES;
  if (!raw) return COPY_MAX_FILE_BYTES_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : COPY_MAX_FILE_BYTES_DEFAULT;
}

export async function contractCreateFromDirCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem; contractSystem: ContractSystem },
  clawId: string,
  dirPath: string,
  extraDeps?: { audit?: AuditLog },
): Promise<void> {
  const audit = extraDeps?.audit;
  const absDir = path.resolve(dirPath);
  const srcFs = deps.fsFactory(absDir);

  const yamlContent = srcFs.readSync(CONTRACT_YAML_FILE);
  const contract = parseAndValidateContractYaml(yamlContent);

  // Phase 230: delegate to ContractSystem.create with policy iteration
  let contractId: string;
  try {
    contractId = await deps.contractSystem.create({
      contract,
      subagentTaskId: process.env.CHESTNUT_SUBAGENT_TASK_ID,
      clawDir: clawId,
    });
  } catch (err) {
    if (err instanceof ContractCreatePolicyViolationError) {
      // phase 687 Step E (audit T3.11): err.details 传给 CliError ctor 是类型混淆 (ctor 只读 options.cause/code)、
      // 真传 { cause: err }；details 通过 (cause as PolicyViolationError).details 仍可访问
      throw new CliError(
        `Contract create rejected by policy '${err.policyName}': ${err.cause}`,
        { cause: err },
      );
    }
    throw err;
  }

  audit?.write(CLI_AUDIT_EVENTS.CONTRACT_CREATE, `claw=${clawId}`, `contract=${contractId}`, `mode=dir`);
  console.log(`Contract created: ${contractId} for claw ${clawId}`);

  // Copy verification/ 目录（若存在；回退读取旧版 acceptance/）
  // phase 324 H10: 硬化拷贝路径，防 attacker-controlled tarball 用 symlink / 危险扩展 / 超大文件 /
  // realpath 越界注入 .sh 到 verifier 可执行处。
  //   - realpath 检 source 落 absDir 内（防 symlink 出/相对路径绕）
  //   - 扩展白名单
  //   - 单文件 size cap
  // .sh 仍允许（合约 verifier 脚本本就是 .sh）但必须从受信 source 内来。
  const srcDir = srcFs.existsSync('verification') ? 'verification' : srcFs.existsSync('acceptance') ? 'acceptance' : undefined;
  if (srcDir) {
    const clawDir = getClawDir(clawId);
    const clawFs = deps.fsFactory(clawDir);
    const destRel = getContractVerificationDir('.', contractId);
    await clawFs.ensureDir(destRel);
    const realAbsDir = await srcFs.realpath('.').catch(() => absDir);
    const maxFileBytes = getCopyMaxFileBytes();
    const entries = await srcFs.list(srcDir);
    for (const entry of entries) {
      const srcRel = path.join(srcDir, entry.name);
      const realSrc = await srcFs.realpath(srcRel).catch(() => null);
      if (!realSrc) {
        audit?.write(CLI_AUDIT_EVENTS.CONTRACT_CREATE, `claw=${clawId}`, `contract=${contractId}`, `skip=realpath_failed`, `entry=${entry.name}`);
        continue;
      }
      // 防 symlink 出 absDir / 相对路径绕：realpath 必须仍落 absDir 内
      const realNorm = path.resolve(realSrc);
      const baseNorm = path.resolve(realAbsDir);
      if (realNorm !== baseNorm && !realNorm.startsWith(baseNorm + path.sep)) {
        audit?.write(CLI_AUDIT_EVENTS.CONTRACT_CREATE, `claw=${clawId}`, `contract=${contractId}`, `skip=symlink_or_escape`, `entry=${entry.name}`);
        continue;
      }
      const srcStat = await srcFs.stat(srcRel);
      if (!srcStat.isFile) {
        // phase 406 Step A (review N3): 嵌套子目录 skip 时 emit audit—verifier
        // 维护者可从 audit 链溯源「`source ./lib/*.sh` 跑空」的原因。
        audit?.write(CLI_AUDIT_EVENTS.CONTRACT_CREATE, `claw=${clawId}`, `contract=${contractId}`, `skip=nested_dir`, `entry=${entry.name}`);
        continue;
      }
      // 扩展白名单
      const ext = path.extname(entry.name).toLowerCase();
      if (!COPY_ALLOWED_EXTENSIONS.has(ext)) {
        audit?.write(CLI_AUDIT_EVENTS.CONTRACT_CREATE, `claw=${clawId}`, `contract=${contractId}`, `skip=ext_not_allowed`, `entry=${entry.name}`, `ext=${ext}`);
        continue;
      }
      // 单文件 size cap
      if (srcStat.size > maxFileBytes) {
        audit?.write(CLI_AUDIT_EVENTS.CONTRACT_CREATE, `claw=${clawId}`, `contract=${contractId}`, `skip=oversize`, `entry=${entry.name}`, `size=${srcStat.size}`, `cap=${maxFileBytes}`);
        continue;
      }
      const destFileRel = path.join(destRel, entry.name);
      // phase 406 Step A (review N2): read via realpath-resolved srcFs-relative path —
      // realpath→read 之间 symlink swap 时间窗的 TOCTOU 修复。realNorm 已在 line 94
      // 校 baseNorm 内、安全 fall in srcFs scope。
      const realRelToBase = path.relative(baseNorm, realNorm);
      const content = await srcFs.read(realRelToBase);
      await clawFs.writeAtomic(destFileRel, content);
    }
  }

  const clawDir = getClawDir(clawId);
  const chestnutRoot = resolveChestnutRoot(clawDir, /* isMotion */ false);
  notifyContractCreated(deps, clawDir, clawId, makeContractId(contractId), contract, chestnutRoot);
}
