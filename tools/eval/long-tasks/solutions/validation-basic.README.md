# 输入校验工具（参考解）

导出函数：

- `isEmailLike(value)`：isEmailLike(value)：粗略邮箱校验（本地部分非空、无空白；域名含 "." 且后缀至少 2 个非空白字符）。
- `isHexColor(value)`：isHexColor(value)：接受 "#rgb" 或 "#rrggbb"（大小写不敏感），其余返回 false。
- `isStrongPassword(value)`：isStrongPassword(value)：长度 >=8 且同时含大写、小写、数字。
