/**
 * @module L6.Assembly.GlobalConfigPath
 *
 * global config 路径解析（`.chestnut/config.yaml`）— Assembly own。
 * phase 704 自 foundation/config/ 迁入（M#3 资源唯一归属）。
 */
import { getWorkspaceRoot, CONFIG_YAML_FILE } from '../../core/claw-topology/index.js';
import * as path from 'path';

export function getGlobalConfigPath(): string {
  return path.join(getWorkspaceRoot(), '.chestnut', CONFIG_YAML_FILE);
}
