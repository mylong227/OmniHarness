/** 沙箱后端 profile 名（G4 多后端切换）。 */
export type SandboxProfile =
  'passthrough' | 'policy' | 'restricted' | 'landlock' | 'seatbelt' | 'bwrap' | 'unshare';
