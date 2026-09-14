import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** 单文件附加大小上限（20MB）。 */
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
/** 单次附加文件个数上限。 */
const MAX_ATTACH_COUNT = 50;
/** 允许附加的 mediaType 前缀白名单（凭扩展名推断后的二次校验）。 */
const ALLOWED_MEDIA_PREFIXES: readonly string[] = [
  'image/',
  'video/',
  'audio/',
  'text/',
  'application/pdf',
  'application/json',
  'application/zip',
];

/** 附加文件读取结果条目。 */
interface AttachedFile {
  readonly name: string;
  readonly mediaType: string;
  readonly data: string;
  readonly size: number;
  readonly kind: 'image' | 'video' | 'audio' | 'file';
}

/**
 * 文件对话框 RPC 服务：文件夹浏览 / 新建目录 / 附件读取。
 *
 * 三者都面向**用户主动选择的绝对路径**（「+添加项目」内嵌选择器、FilePicker 附件），
 * 因此不做工作区越界检查——安全由类型白名单 + 大小上限 + 数量上限兜底（fail-closed）。
 * 本类无实例状态，可安全复用；工作区内的树形列举/读取见 `WorkspaceTree`。
 */
export class FsExplorer {
  /**
   * 文件夹浏览 RPC（「+ 添加项目」）：列出某目录下的子目录，供 UI 内嵌文件夹选择器。
   * path 缺省时返回 Windows 盘符列表 + 用户目录（服务端跑在本机——这是浏览器沙箱
   * 拿不到真实绝对路径时唯一能给出真路径的方案，替代手输弹框）。
   * @param params `{ path?: string; includeFiles?: boolean }`
   * @returns 盘符层 `{ level:'drives', roots, home }` 或目录层 `{ level:'dir', path, parent?, dirs, files? }`
   */
  public browse(params: Record<string, unknown>): unknown {
    const raw = params['path'];
    const includeFiles = params['includeFiles'] === true;
    if (typeof raw !== 'string' || raw.trim() === '') {
      return this.drives();
    }
    const target = resolve(raw.trim());
    let entries: Dirent[];
    try {
      entries = readdirSync(target, { withFileTypes: true });
    } catch (e) {
      throw new Error(`无法读取目录 ${target}：${(e as Error).message}`);
    }
    const dirs = entries
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' }));
    const parent = dirname(target);
    const result: {
      level: 'dir';
      path: string;
      parent?: string | undefined;
      dirs: string[];
      files?: { name: string; size: number; mediaType: string }[];
    } = {
      level: 'dir',
      path: target,
      parent: parent === target ? undefined : parent,
      dirs,
    };
    if (includeFiles) {
      result.files = this.listFiles(entries, target);
    }
    return result;
  }

  /**
   * 新建文件夹 RPC（「+ 新建项目」）：在指定父目录下创建子文件夹，返回新目录的绝对路径。
   * 名称做安全裁剪——拒绝路径分隔符 / 空名 / 越级（..），保证只在 parent 内落盘，
   * 不会因 UI 传入恶意名而在任意位置建目录（fail-closed：任何异常原样抛给前端显错）。
   * @param params `{ parent: string; name: string }`
   * @returns `{ path: string }` 新目录绝对路径
   */
  public mkdir(params: Record<string, unknown>): unknown {
    const parentRaw = params['parent'];
    const nameRaw = params['name'];
    if (typeof parentRaw !== 'string' || parentRaw.trim() === '') {
      throw new Error('请先进入一个目录再新建文件夹');
    }
    if (typeof nameRaw !== 'string' || nameRaw.trim() === '') {
      throw new Error('文件夹名称不能为空');
    }
    const name = FsExplorer.sanitizeFolderName(nameRaw);
    if (name === '') {
      throw new Error('非法的文件夹名称：' + nameRaw);
    }
    const parent = resolve(parentRaw.trim());
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new Error('父目录不存在：' + parent);
    }
    const target = join(parent, name);
    if (existsSync(target)) {
      throw new Error('该文件夹已存在：' + target);
    }
    mkdirSync(target, { recursive: false });
    return { path: target };
  }

  /**
   * 附件读取 RPC（FilePicker 选完文件后批量读 base64）：专为 Composer 附加文件设计，
   * 不限工作区（用户主动从全盘选），但有硬性白名单 + 大小限制兜底安全：
   *   - 单文件 ≤ 20MB、单次 ≤ 50 个、总大小未限（base64 后服务端内存瞬时翻 ~1.37x）
   *   - 类型白名单：image/ video/ audio/ text/ application/pdf|json|zip
   *   - 路径必须 resolve 后存在且 isFile()，单文件失败不阻断整体（errors[] 收集）
   * @param params `{ paths: unknown }` 期望为字符串路径数组
   * @returns `{ files: AttachedFile[]; errors: { path:string; error:string }[] }`
   */
  public readAttachments(params: Record<string, unknown>): unknown {
    const paths = params['paths'];
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error('paths 必须是非空数组');
    }
    if (paths.length > MAX_ATTACH_COUNT) {
      throw new Error(`单次最多附加 ${MAX_ATTACH_COUNT} 个文件`);
    }
    const files: AttachedFile[] = [];
    const errors: { path: string; error: string }[] = [];
    for (const p of paths) {
      const one = this.readOne(p);
      if ('error' in one) {
        errors.push({ path: one.path, error: one.error });
      } else {
        files.push(one.file);
      }
    }
    return { files, errors };
  }

  /**
   * 盘符层响应：存在的盘符 + 用户目录。
   * @returns `{ level:'drives', roots, home }`；roots 为 A:–Z: 中实际存在的盘符
   */
  private drives(): unknown {
    const roots: string[] = [];
    for (let i = 65; i <= 90; i += 1) {
      const letter = `${String.fromCharCode(i)}:\\`;
      if (existsSync(letter)) roots.push(letter);
    }
    return { level: 'drives' as const, roots, home: homedir() };
  }

  /**
   * 目录层文件清单（按名称本地化排序；单文件 stat 失败静默跳过）。
   * @param entries 目录 readdir 结果（含子目录，此处仅保留普通文件）
   * @param target 目录绝对路径（与文件名拼接做 stat）
   * @returns 文件名、大小与推断 mediaType 的清单
   */
  private listFiles(
    entries: readonly Dirent[],
    target: string,
  ): { name: string; size: number; mediaType: string }[] {
    const files: { name: string; size: number; mediaType: string }[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      let st;
      try {
        st = statSync(join(target, e.name));
      } catch {
        continue;
      }
      files.push({ name: e.name, size: st.size, mediaType: FsExplorer.inferMediaType(e.name) });
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base' }));
    return files;
  }

  /**
   * 读取单个附件：校验 → 白名单 → 读盘 → base64；失败返回 `{ path, error }`。
   * @param value 单个路径条目（期望字符串，其他类型按无效路径处理）
   * @returns 成功时 `{ file }`（含 base64 数据与附件种类）；失败时 `{ path, error }`，不抛错
   */
  private readOne(value: unknown): { file: AttachedFile } | { path: string; error: string } {
    if (typeof value !== 'string' || value.trim() === '') {
      return { path: String(value), error: '路径无效' };
    }
    const target = resolve(value.trim());
    let st;
    try {
      st = statSync(target);
    } catch (e) {
      return { path: target, error: '文件不存在或不可访问：' + (e as Error).message };
    }
    if (!st.isFile()) {
      return { path: target, error: '不是文件' };
    }
    if (st.size > MAX_ATTACH_BYTES) {
      return { path: target, error: `文件超过 ${MAX_ATTACH_BYTES / 1024 / 1024}MB 限制` };
    }
    const name = basename(target);
    const mediaType = FsExplorer.inferMediaType(name);
    if (!ALLOWED_MEDIA_PREFIXES.some((p) => mediaType.startsWith(p))) {
      return { path: target, error: '不支持的文件类型：' + mediaType };
    }
    let buf: Buffer;
    try {
      buf = readFileSync(target);
    } catch (e) {
      return { path: target, error: '读取失败：' + (e as Error).message };
    }
    return {
      file: {
        name,
        mediaType,
        data: buf.toString('base64'),
        size: st.size,
        kind: FsExplorer.mediaKind(mediaType),
      },
    };
  }

  /**
   * 由文件扩展名推断 mediaType（无 mime-types 依赖；零依赖铁律）。
   * 覆盖 attach.read 与 browseFs(includeFiles) 的输出。
   * @param name 文件名（含扩展名）
   * @returns 推断出的 MIME 类型；未知扩展名回退 `application/octet-stream`
   */
  private static inferMediaType(name: string): string {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return 'application/octet-stream';
    const ext = name.slice(dot + 1).toLowerCase();
    const map: Record<string, string> = {
      // 图片
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      bmp: 'image/bmp',
      ico: 'image/x-icon',
      // 视频
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      webm: 'video/webm',
      mkv: 'video/x-matroska',
      avi: 'video/x-msvideo',
      // 音频
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      m4a: 'audio/mp4',
      flac: 'audio/flac',
      // 文本
      txt: 'text/plain',
      md: 'text/markdown',
      json: 'application/json',
      csv: 'text/csv',
      xml: 'application/xml',
      html: 'text/html',
      htm: 'text/html',
      // 文档
      pdf: 'application/pdf',
      // 压缩
      zip: 'application/zip',
      tar: 'application/x-tar',
      gz: 'application/gzip',
      // 代码（粗略，浏览器可能不识别但能下载/查看）
      ts: 'text/typescript',
      tsx: 'text/tsx',
      js: 'text/javascript',
      jsx: 'text/jsx',
      py: 'text/x-python',
      rs: 'text/x-rust',
      go: 'text/x-go',
      java: 'text/x-java',
    };
    return map[ext] ?? 'application/octet-stream';
  }

  /**
   * 裁剪用户输入的文件夹名：剔除路径分隔符与前导点/非法字符。
   * @param raw 原始名称
   * @returns 安全名称；`''` / `'.'` / `'..'` 视为非法返回空串
   */
  private static sanitizeFolderName(raw: string): string {
    const name = raw
      .trim()
      .replace(/[\\/]+/g, '')
      .replace(/^[\.]+|[\0<>:"|?*]/g, '');
    if (name === '' || name === '.' || name === '..') {
      return '';
    }
    return name;
  }

  /**
   * 按 mediaType 归类附件种类。
   * @param mediaType 推断出的 MIME 类型
   * @returns 附件种类（image/video/audio/file）
   */
  private static mediaKind(mediaType: string): AttachedFile['kind'] {
    if (mediaType.startsWith('image/')) return 'image';
    if (mediaType.startsWith('video/')) return 'video';
    if (mediaType.startsWith('audio/')) return 'audio';
    return 'file';
  }
}
