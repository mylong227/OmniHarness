/** 沙箱后端 profile 名（G4 多后端切换）。 */
export type SandboxProfile =
  | 'passthrough'
  | 'policy'
  | 'restricted'
  /** Windows 原生写隔离（WRITE_RESTRICTED + 工作区 SID + DACL；需 omni-cli 二进制）。 */
  | 'windows-native'
  | 'landlock'
  | 'seatbelt'
  | 'bwrap'
  | 'unshare'
  | 'wsl-bwrap'
  /** 容器沙箱（P2-2，可选档、非默认）：Docker/Podman + 只读根 + 断网 + workspace rw 挂载。 */
  | 'container';
