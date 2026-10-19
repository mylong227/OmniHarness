#!/usr/bin/env node
/**
 * 会话大附件一次性迁移（2026-10-20）。
 *
 * ## 做什么
 *
 * 把历史 JSONL 里 `tool_result.files[].data` / `user.files[].data` 的**大附件**（>256K 字符）
 * 外置到 `<sessions>/attachments/<sha256>.<ext>`，事件里改存相对路径 `attachments/<...>`。
 * 与运行时 `SessionAttachmentSpiller` 同一口径（阈值 / 内容寻址 / 相对路径），迁移后的存档
 * 与新版写入的存档完全一致。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/migrateSessionAttachments.mjs                 # 只报告，不写盘（dry-run）
 * node scripts/migrateSessionAttachments.mjs --apply         # 真正迁移（原子 tmp+rename）
 * node scripts/migrateSessionAttachments.mjs --dir=<目录>    # 指定 sessions 目录
 * ```
 *
 * ## 安全边界
 *
 * - 默认 dry-run；`--apply` 才写盘。
 * - 逐文件解析：**任何一行 JSON 解析失败就跳过整个文件**（不拿半份历史冒险）。
 * - 写盘用 `<file>.tmp` + `rename`，与运行时落盘同一原子语义；不保留 `.bak`（附件按内容
 *   寻址原样保留，重跑幂等）。
 * - 幂等：已带 `path` 无 `data` 的事件不会被二次处理。
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 与 `SessionAttachmentSpiller.SPILL_THRESHOLD_CHARS` 保持一致。 */
const THRESHOLD = 256 * 1024;

/** mediaType → 扩展名（与 spiller 同一张表）。 */
const MEDIA_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
};

/** `--key=value` / `--flag` 解析。 */
const args = new Map();
for (const arg of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/s.exec(arg);
  if (m) args.set(m[1], m[2]);
  else if (arg.startsWith('--')) args.set(arg.slice(2), '');
}
const DIR = resolve(args.get('dir') ?? join(homedir(), '.omniharness', 'sessions'));
const APPLY = args.has('apply');

/** 附件扩展名（未知类型回落 `.bin`）。 */
function extensionOf(file) {
  const byMedia = MEDIA_EXTENSIONS[String(file.mediaType ?? '').toLowerCase()];
  if (byMedia !== undefined) return byMedia;
  const name = String(file.name ?? '');
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin';
}

let scanned = 0;
let changedFiles = 0;
let spilled = 0;
let reused = 0;
let beforeBytes = 0;
let afterBytes = 0;

const attachmentsDir = join(DIR, 'attachments');
for (const name of readdirSync(DIR)
  .filter((n) => n.endsWith('.jsonl'))
  .sort()) {
  const file = join(DIR, name);
  scanned += 1;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    console.warn(`skip unreadable: ${name}`);
    continue;
  }
  const lines = text.split('\n');
  let parseFailed = false;
  let changed = false;
  const nextLines = lines.map((line) => {
    if (line.trim() === '') return line;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      parseFailed = true;
      return line;
    }
    const payload = event?.payload;
    const files = payload?.files;
    if (!Array.isArray(files)) return line;
    let fileChanged = false;
    const nextFiles = files.map((f) => {
      if (f === null || typeof f !== 'object') return f;
      if (typeof f.data !== 'string' || f.data.length <= THRESHOLD) return f;
      const bytes = Buffer.from(f.data, 'base64');
      const digest = createHash('sha256').update(bytes).digest('hex');
      const rel = `attachments/${digest}${extensionOf(f)}`;
      const abs = join(DIR, rel);
      if (APPLY) {
        mkdirSync(attachmentsDir, { recursive: true });
        if (existsSync(abs)) {
          reused += 1;
        } else {
          writeFileSync(abs, bytes);
          spilled += 1;
        }
      } else if (existsSync(abs)) {
        reused += 1;
      } else {
        spilled += 1;
      }
      fileChanged = true;
      const { data: _data, ...rest } = f;
      return { ...rest, path: rel };
    });
    if (!fileChanged) return line;
    changed = true;
    return JSON.stringify({ ...event, payload: { ...payload, files: nextFiles } });
  });
  if (parseFailed) {
    console.warn(`skip corrupt: ${name}（存在无法解析的行，整文件保持原样）`);
    continue;
  }
  if (!changed) continue;
  changedFiles += 1;
  const beforeSize = Buffer.byteLength(text, 'utf8');
  beforeBytes += beforeSize;
  const nextText = nextLines.join('\n');
  afterBytes += Buffer.byteLength(nextText, 'utf8');
  if (APPLY) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, nextText, 'utf8');
    renameSync(tmp, file);
  }
  console.log(
    `${APPLY ? 'migrated' : 'would migrate'} ${name}: ` +
      `${(beforeSize / 1048576).toFixed(2)} MiB → ` +
      `${(Buffer.byteLength(nextText, 'utf8') / 1048576).toFixed(2)} MiB`,
  );
}

console.log(
  `\n${APPLY ? 'applied' : 'dry-run'}: scanned=${scanned} changedFiles=${changedFiles} ` +
    `attachments=${spilled} reused=${reused} ` +
    `bytes=${(beforeBytes / 1048576).toFixed(2)}MiB → ${(afterBytes / 1048576).toFixed(2)}MiB` +
    `${APPLY ? '' : '（加 --apply 才会写盘）'}`,
);
if (APPLY && changedFiles > 0) {
  console.log(`attachments dir: ${attachmentsDir}`);
}
