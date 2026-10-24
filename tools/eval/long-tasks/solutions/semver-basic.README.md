# 语义化版本子集（参考解）

导出函数：

- `parseSemver(version)`：parseSemver(version)：解析 "major.minor.patch" 为 {major,minor,patch}；不合法返回 null。
- `compareSemver(a, b)`：compareSemver(a, b)：a<b 返回 -1、相等 0、a>b 返回 1；任一版本非法时抛错。
- `satisfiesCaret(version, range)`：satisfiesCaret(version, range)：支持 "^1.2.3"（>=1.2.3 且 <2.0.0）、"^0.2.3"（>=0.2.3 且 <0.3.0）、"^0.0.3"（=0.0.3）。
