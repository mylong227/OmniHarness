/** 沙箱后端 profile 名（G4 多后端切换）。 */
export type SandboxProfile =
  | 'passthrough'
  | 'policy'
  | 'restricted'
  | 'landlock'
  | 'seatbelt'
  | 'bwrap'
  | 'unshare'
  | 'wsl-bwrap'
  | 'windows-acl'
  | 'windows-acl-readonly'
  /** 容器沙箱（P2-2，可选档、非默认）：Docker/Podman + 只读根 + 断网 + workspace rw 挂载。 */
  | 'container';
