/**
 * 资产包端口桶（Wave D · ADR-0011）：契约各自独立成文件于 `./asset/`，本文件只做桶导出。
 * 端口恒第三方-free、零实现类（`arch:gate` [3] 强制）。
 */
export type {
  AssetPackInstallRequest,
  AssetPackManifest,
  AssetPackPort,
  InstallReport,
  PackAssetEntry,
  PackPublisher,
  RegistryMetadata,
} from './asset/assetPack.js';
