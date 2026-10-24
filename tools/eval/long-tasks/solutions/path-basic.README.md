# 路径工具（POSIX 子集）（参考解）

导出函数：

- `joinPath(...parts)`：joinPath(...parts)：用 "/" 连接并规范化（合并空段、处理 "." 与 ".."；绝对路径保持前导 "/"；不能越过根）。
- `basenameNoExt(path)`：basenameNoExt(path)：取最后一段并去掉最后一个扩展名；隐藏文件（如 ".gitignore"）与无扩展名文件原样返回。
- `isAbsolutePath(path)`：isAbsolutePath(path)：识别 POSIX 前导 "/"、Windows 盘符（如 C:\x）与 UNC（\\server\share）。
