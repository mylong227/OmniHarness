/** 断言工具：条件不成立即抛错退出。 */
export function works(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`断言失败: ${label}`);
  }
  process.stdout.write(`  ✓ ${label}\n`);
}
