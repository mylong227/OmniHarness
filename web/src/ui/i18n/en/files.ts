// en 词条分片：文件区（FilePicker/FolderPicker/CodeSurface/SearchResults 及文件模型）。键 = 中文原文（与 t() 的键逐字一致，含 {name} 占位符）。
export const EN_FILES: Record<string, string> = {
  // FilePicker / FolderPicker 共用
  '（用户目录）': ' (home directory)',
  '..（上级目录）': '.. (parent directory)',
  '（空目录）': '(empty directory)',
  '关闭 (Esc)': 'Close (Esc)',
  '此电脑（选择盘符）': 'This PC (select a drive)',
  '读取中…': 'Loading…',
  '取消': 'Cancel',
  // FilePicker
  '文件列表返回格式异常（fs.browse）': 'Unexpected file list response (fs.browse)',
  '选择附件文件': 'Select attachment files',
  '已选 {count} 个': '{count} selected',
  '添加 {count} 个文件': 'Add {count} files',
  '添加文件': 'Add files',
  // FolderPicker
  '新项目': 'New project',
  '在 {path} 内新建：': 'Create new in {path}:',
  '文件夹名称': 'Folder name',
  '创建': 'Create',
  '目录列表返回格式异常（fs.browse）': 'Unexpected directory list response (fs.browse)',
  '请输入文件夹名称': 'Please enter a folder name',
  '选择项目文件夹': 'Select project folder',
  '在当前目录内新建项目文件夹': 'Create a new project folder in the current directory',
  '新建文件夹': 'New folder',
  '选择此文件夹': 'Select this folder',
  // CodeSurface（FileModal 组件已于 2026-10-18 删除）
  '关闭文件预览': 'Close file preview',
  '关闭': 'Close',
  '代码内容': 'Code content',
  // SearchResults
  '搜索中…': 'Searching…',
  '无匹配结果': 'No matching results',
  '找到 {count} 条结果': 'Found {count} results',
  '会话与文件搜索结果': 'Session and file search results',
  // FileController
  '二进制文件': 'Binary file',
  '已截断（>200KB）': 'Truncated (>200KB)',
  '{tag} · {size} 字节': '{tag} · {size} bytes',
  '{size} 字节': '{size} bytes',
  '（二进制文件，无法预览）': '(Binary file, preview unavailable)',
  '打开失败：{msg}': 'Failed to open: {msg}',
};
