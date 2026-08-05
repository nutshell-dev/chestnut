/**
 * @module L2a.ConfigStore
 *
 * ConfigStore public barrel（phase 1297 Step A）。
 * 只暴露四个 generic YAML 能力与 LoaderDeps 类型；跨模块 import 必经本 barrel，
 * 禁止 deep-import ./store.js。
 */
export {
  loadYamlConfig,
  writeYamlConfig,
  patchYamlConfig,
  configExists,
  type LoaderDeps,
} from './store.js';
