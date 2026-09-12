import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let shared: string | undefined;

/**
 * 测试专用最小临时工作区（每进程惰性创建一个，进程结束由系统临时目录回收）。
 * 单测的 RPC 语义断言不依赖真实仓库内容；指到真实仓库根会让首回合的
 * workspace 扫描（项目指令 / repo map）付出秒级~十秒级成本，在整套回归的
 * CPU 争抢下撞破测试内建轮询死线（15s），造成大面积假失败。
 */
export function tempWorkspace(): string {
  shared ??= fs.mkdtempSync(path.join(os.tmpdir(), 'omniharness-test-ws-'));
  return shared;
}
