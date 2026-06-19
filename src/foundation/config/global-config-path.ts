/**
 * @module L2c.Config.GlobalConfigPath
 * global config 路径解析（`.chestnut/config.yaml`）— foundation/config own
 * per M#3 资源唯一归属（global config 路径归 config 模块、与 crud.ts load/save/exists 同模块）。
 *
 * phase 73 自 foundation/paths.ts 整迁、cluster L1-L4 去 claw 化 paths.ts 解散第四步、详
 * `coding plan/cluster-claw-decoupling-roadmap.md`。
 *
 * getWorkspaceRoot（chestnut 安装根原语）保 paths.ts、phase 74 cluster 处理。
 */

import { getWorkspaceRoot, CONFIG_YAML_FILE } from '../install-paths.js';
import * as path from 'path';

export function getGlobalConfigPath(): string {
  return path.join(getWorkspaceRoot(), '.chestnut', CONFIG_YAML_FILE);
}
