/**
 * 拖拽落点的附件通道决策（纯逻辑，2026-10-27 桌面原生拖拽收口）。
 *
 * ## 为什么需要决策而不是直接读文件
 *
 * 浏览器拖拽只能拿到 `File` 对象（内容可读、**没有真实路径**）；桌面 Electron ≥32 又把
 * `File.path` 移除了——真实路径只能经 preload 的 `webUtils.getPathForFile` 跨桥取。
 * 有真实路径就走服务端 `attach.read`（与 FilePicker 同一通道：大文件不必整个 base64
 * 复制进渲染层内存再走 RPC）；拿不到路径（浏览器 / 虚拟文件 / 桥降级）才回落浏览器读。
 *
 * ## 全有或全无
 *
 * 一批拖入文件里只要有一个取不到路径，就**整批回落**浏览器读——一半走路径一半走内容
 * 会让同一个附件芯片出现两种生命周期（服务端路径 vs 渲染层内存），排障成本高于收益。
 */

/**
 * 决策一批拖入文件走哪条附件通道。
 * @param files 拖入的文件（顺序即 UI 展示顺序）。
 * @param pathFor 桌面桥的取路径能力（浏览器下为 undefined）。
 * @returns 真实路径列表（走服务端）；`null` = 不走路径通道，整批回落浏览器读。
 */
export function pathsForDrop(
  files: readonly File[],
  pathFor: ((file: File) => string) | undefined,
): readonly string[] | null {
  if (pathFor === undefined || files.length === 0) return null;
  const paths: string[] = [];
  for (const file of files) {
    let path = '';
    try {
      path = pathFor(file);
    } catch {
      return null;
    }
    if (path === '') return null;
    paths.push(path);
  }
  return paths;
}
