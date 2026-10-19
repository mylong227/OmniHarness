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
  // 右栏网页标签（BrowserPane / RightPanel / BrowserController，2026-10-19）
  '网页': 'Web',
  '文件与网页': 'Files and web',
  '关闭网页标签': 'Close web tab',
  '在右侧打开网页': 'Open a web page on the right',
  '在浏览器中预览': 'Preview in browser',
  '预览': 'Preview',
  '在右栏打开': 'Open in right panel',
  '网页地址': 'Web address',
  '输入网址或工作区路径，如 http://localhost:5173 或 index.html':
    'Enter a URL or workspace path, e.g. http://localhost:5173 or index.html',
  '在新窗口打开': 'Open in new window',
  '网页预览': 'Web preview',
  '在右栏浏览网页': 'Browse web pages on the right',
  '输入网址或工作区里的 HTML 路径，回车即可预览；本地 dev server 启动后把地址粘进来即可。':
    'Enter a URL or an HTML path in the workspace and press Enter to preview; paste a local dev server address once it is running.',
  '最近出现的本地地址': 'Recent local addresses',
  '预览工作区首页': 'Preview workspace home page',
  '部分站点禁止被 iframe 嵌入（X-Frame-Options / CSP），页面空白时请用「在新窗口打开」。':
    'Some sites refuse to be embedded in an iframe (X-Frame-Options / CSP); if the page is blank, use "Open in new window".',
  '请输入要浏览的地址': 'Enter an address to browse',
  '地址格式无法识别：请输入 http(s):// 网址、主机:端口，或工作区文件路径':
    'Unrecognized address: enter an http(s) URL, host:port, or a workspace file path',
  '只能预览工作区内的相对路径（不能以 /、~、盘符开头，也不能包含 ..）':
    'Only workspace-relative paths can be previewed (no leading /, ~, drive letter, or ..)',
  '本地网页预览未启用（服务端没有启动预览源）':
    'Local web preview is not enabled (the server did not start a preview source)',
  '当前不是通过回环地址打开的界面，本地文件预览不可用':
    'This UI is not opened via a loopback address, so local file preview is unavailable',
};
