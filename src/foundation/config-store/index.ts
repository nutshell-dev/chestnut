/**
 * @module L2a.ConfigStore
 *
 * ConfigStore public barrel（phase 1297）。
 * 公开通用 YAML 配置读写、互斥与失败能力；
 * 跨模块 import 必经本 barrel，禁止 deep-import ./store.js / ./errors.js。
 */
export {
  readYamlDocument,
  loadYamlConfig,
  writeYamlConfig,
  writeYamlConfigExclusive,
  patchYamlConfig,
  withYamlConfigLock,
  withYamlConfigLockAsync,
  configExists,
} from './store.js';
export {
  ConfigStoreError,
  isConfigStoreError,
} from './errors.js';
