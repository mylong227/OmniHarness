/**
 * IP 字面量分类（零依赖）——**SSRF 护栏与出站白名单共用的唯一实现**。
 *
 * ## 为什么抽出来（2026-09-22 修，审计 P3）
 *
 * 同一族判定此前有两份独立实现：`security/ssrfGuard.ts`（已按 IPv6 数值分组解析内嵌 IPv4）与
 * `adapters/sandbox/networkEgressGuard.ts`（只有 `^::1$` / `^fe80:` / `^fc..` / `^fd..` 几条前缀正则）。
 * 后者因此**漏掉 IPv4-mapped 写法**：`http://[::ffff:169.254.169.254]/` 在出站守卫眼里既不是
 * `169.254.*`（点分正则不匹配）也不是 `fc/fd/fe80` ⇒ 「元数据一律拒绝」的声明在该写法下不成立。
 * 两份实现的分叉已经造成过一次真实缺口，故合并为一份、由两侧共用。
 *
 * ## 覆盖形态（安全优先，宁可多判一层）
 *
 * IPv4：按调用方传入的 CIDR 网段表判定。**本模块不再内置网段表**（用户指令：不在代码里硬编码，
 * 方便以后维护）——默认表在 `defaults/ssrf.json`，由 `security/ssrfPolicy.ts` 读出并随策略注入；
 * 出厂默认覆盖 0/8、10/8、100.64/10、127/8、169.254/16、172.16/12、192.0.0/24、192.168/16、
 * 198.18/15、224/4、240/4。
 * IPv6：环回 `::1`、未指定 `::`、ULA `fc00::/7`、链路本地 `fe80::/10`、组播 `ff00::/8`，
 * 以及**内嵌 IPv4** 的四种形态——IPv4-mapped `::ffff:0:0/96`（含尾部点分写法）、
 * IPv4-compatible `::/96`、NAT64 `64:ff9b::/96`、6to4 `2002::/16`；内嵌 IPv4 同样按传入网段表判定。
 */

/**
 * IPv4 点分十进制转 32 位整数。
 * @param ip 点分十进制 IPv4
 * @returns 32 位无符号整数；非法输入返回 null
 */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (n > 255) {
      return null;
    }
    value = value * 256 + n;
  }
  return value;
}

/**
 * IPv4 是否落在给定私有/保留网段表内。
 * @param ip 点分十进制 IPv4
 * @param cidrs 网段表（**必传**：默认表在 `defaults/ssrf.json`，由调用方经策略注入；
 *   此前这里的默认参数使配置化的 `ssrfPolicy.ipv4Blocks` 在 IPv6 内嵌路径上被静默绕过）
 * @returns 命中任一 CIDR 为 true；不可解析时**fail-closed 返回 true**
 */
export function isPrivateIpv4(ip: string, cidrs: readonly (readonly [string, number])[]): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) {
    return true;
  }
  for (const [base, bits] of cidrs) {
    const baseValue = ipv4ToInt(base);
    if (baseValue === null) {
      continue;
    }
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (baseValue & mask) >>> 0) {
      return true;
    }
  }
  return false;
}

/**
 * 把「尾部点分 IPv4」的混合写法展开为纯十六进制分组（`::ffff:169.254.169.254` → `::ffff:a9fe:a9fe`）。
 * @param ip IPv6 字面量（可能带点分尾巴）
 * @returns 纯十六进制 IPv6 字面量；无点分尾巴或数值非法时原样返回
 */
export function expandTrailingIpv4(ip: string): string {
  const m = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (m === null) {
    return ip;
  }
  const nums = [m[2], m[3], m[4], m[5]].map((x) => Number(x));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return ip;
  }
  const hi = ((nums[0] ?? 0) * 256 + (nums[1] ?? 0)).toString(16);
  const lo = ((nums[2] ?? 0) * 256 + (nums[3] ?? 0)).toString(16);
  return `${m[1] ?? ''}${hi}:${lo}`;
}

/**
 * 解析 IPv6 为 8 组 16 位整数（支持 `::` 缩写与 `%zone` 后缀）。
 * @param ip IPv6 字面量
 * @returns 8 组整数；不可解析返回 null
 */
export function parseIpv6Groups(ip: string): number[] | null {
  const clean = (ip.split('%')[0] ?? ip).toLowerCase();
  const halves = clean.split('::');
  if (halves.length > 2) {
    return null;
  }
  const parseSide = (part: string): number[] | null => {
    if (part === '') {
      return [];
    }
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) {
        return null;
      }
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const left = parseSide(halves[0] ?? '');
  const right = parseSide(halves.length === 2 ? (halves[1] ?? '') : '');
  if (left === null || right === null) {
    return null;
  }
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const fill = 8 - left.length - right.length;
  if (fill < 0) {
    return null;
  }
  return [...left, ...new Array<number>(fill).fill(0), ...right];
}

/**
 * 从 IPv6 字面量中取出**内嵌的 IPv4**（点分十进制）；无内嵌返回 null。
 * @param ip 已去方括号、已小写的 IPv6 字面量
 * @returns 内嵌 IPv4 的点分十进制形式；无内嵌或不可解析时为 null
 */
export function embeddedIpv4(ip: string): string | null {
  const groups = parseIpv6Groups(expandTrailingIpv4(ip));
  if (groups === null) {
    return null;
  }
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const dotted = (hi: number, lo: number): string =>
    `${String(hi >> 8)}.${String(hi & 0xff)}.${String(lo >> 8)}.${String(lo & 0xff)}`;
  const mapped =
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0);
  if (mapped) {
    return dotted(g6, g7);
  }
  if (g0 === 0x64 && g1 === 0xff9b) {
    return dotted(g6, g7); // NAT64
  }
  if (g0 === 0x2002) {
    return dotted(g1, g2); // 6to4
  }
  return null;
}

/**
 * IPv6 是否属于需屏蔽的本机/私有地址（含内嵌 IPv4 的等价写法）。
 * @param ip IPv6 字面量（可带方括号）
 * @param cidrs IPv4 网段表（**必传**）：内嵌 IPv4 的判定必须与纯 IPv4 路径同一张表，
 *   否则「配置了 ipv4Blocks 却仍按出厂网段拦 `[::ffff:10.0.0.1]`」这类双口径会长期潜伏
 * @returns 需要屏蔽为 true；不可解析时 **fail-closed 返回 true**
 */
export function isPrivateIpv6(ip: string, cidrs: readonly (readonly [string, number])[]): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::1' || lower === '::') {
    return true;
  }
  const embedded = embeddedIpv4(lower);
  if (embedded !== null) {
    return isPrivateIpv4(embedded, cidrs);
  }
  const groups = parseIpv6Groups(lower);
  if (groups === null) {
    return true; // 解析不了 ⇒ fail-closed（宁可拦错不可漏放）
  }
  const h0 = groups[0] ?? 0;
  if ((h0 & 0xfe00) === 0xfc00) {
    return true; // fc00::/7 唯一本地
  }
  if ((h0 & 0xffc0) === 0xfe80) {
    return true; // fe80::/10 链路本地
  }
  if ((h0 & 0xff00) === 0xff00) {
    return true; // ff00::/8 组播
  }
  return false;
}
