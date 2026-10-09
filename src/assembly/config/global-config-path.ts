/**
 * @module L6.Assembly.GlobalConfigPath
 *
 * global config 路径解析（`.chestnut/config.yaml`）— Assembly own。
 * phase 704 自 foundation/config/ 迁入（M#3 资源唯一归属）。
 */
import { getChestnutRoot, CONFIG_YAML_FILE } from '../../foundation/claw-identity/index.js';
import * as path from 'path';

export function getGlobalConfigPath(): string {
  // Phase 1930 Step B：直接在实例根拼 config（父目录 API 已退役）。
  return path.join(getChestnutRoot(), CONFIG_YAML_FILE);
}
