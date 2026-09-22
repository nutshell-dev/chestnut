/**
 * @module L4.ContractSystem.ArchivePayloadLayout
 * Archive payload 路径助手（flat 布局：contract.yaml + progress.json）。
 *
 * Phase 1898: strict 内容格式（contract.yaml + subtasks/*.json）读半已删——
 * 该格式无 writer（since Phase 1193 Step A）。`getContractSubtasksDir` 保留仅因
 * archive-reader 分流探测仍需定位 subtasks/ 目录（探测存在 ≠ 支持解析）。
 */

import * as path from 'path';
import { CONTRACT_SUBTASKS_DIR, CONTRACT_YAML_FILE } from './dirs.js';

export function getContractSubtasksDir(root: string): string {
  return path.join(root, CONTRACT_SUBTASKS_DIR);
}

export function getContractYamlPath(root: string): string {
  return path.join(root, CONTRACT_YAML_FILE);
}
