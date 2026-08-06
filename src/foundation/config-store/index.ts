/**
 * @module L2a.ConfigStore
 *
 * ConfigStore public barrel（phase 1297）。
 * 只暴露四个 generic YAML 能力、typed failure protocol 与必要类型；
 * 跨模块 import 必经本 barrel，禁止 deep-import ./store.js / ./errors.js。
 */
export {
  loadYamlConfig,
  writeYamlConfig,
  patchYamlConfig,
  configExists,
} from './store.js';
export {
  ConfigStoreError,
  isConfigStoreError,
} from './errors.js';
