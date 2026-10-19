// 扩展名 → MIME 类型（零第三方依赖，离线可用）。
//
// 为什么单列一份（2026-10-19）：此前这张表住在 `server/services/fsExplorer.ts` 的私有方法里，
// 只服务附件读取；新增「工作区网页预览」需要同一份判定（预览源按 MIME 下发 HTML / JS / 字体，
// 否则浏览器会把样式与模块当二进制下载）。两处各抄一份会漂——而且 MIME 一漂就是**静默**的
// （浏览器不报错，页面只是不渲染），所以这里做唯一事实源，`fsExplorer` 改为委托本类。
//
// 口径：只放**静态资源**需要的类型；未知扩展名回落 `application/octet-stream`（fail-closed：
// 宁可让浏览器下载，也不猜一个危险类型）。

/** 扩展名（小写、不含点）→ MIME 类型。 */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  // 文档 / 网页
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/jsx',
  ts: 'text/typescript',
  tsx: 'text/tsx',
  json: 'application/json',
  map: 'application/json',
  webmanifest: 'application/manifest+json',
  xml: 'application/xml',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  // 图片
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  // 字体
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  // 二进制 / 多媒体
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  // 常见脚本语言（源码预览 / 下载；浏览器不会执行它们）
  py: 'text/x-python',
  rs: 'text/x-rust',
  go: 'text/x-go',
  java: 'text/x-java',
  sh: 'text/x-shellscript',
};

/** 扩展名 → MIME 判定（唯一事实源）。 */
export class MimeType {
  /**
   * 由文件名（或路径）推断 MIME 类型。
   * @param file 文件名或路径（只看最后一个扩展名；大小写不敏感）
   * @returns MIME 类型；无扩展名 / 未登记扩展名返回 `application/octet-stream`
   */
  public static of(file: string): string {
    const dot = file.lastIndexOf('.');
    if (dot < 0 || dot === file.length - 1) return 'application/octet-stream';
    const ext = file.slice(dot + 1).toLowerCase();
    return MIME_BY_EXT[ext] ?? 'application/octet-stream';
  }
}
