# Markdown 大纲工具（参考解）

导出函数：

- `stripCodeFences(markdown)`：stripCodeFences(markdown)：删除 ``` 围栏代码块（含内容），保留其余文本。
- `extractHeadings(markdown)`：extractHeadings(markdown)：提取围栏外的 ATX 标题（1..6 个 #），返回 [{level, text}]（按出现顺序）。
- `buildToc(headings)`：buildToc(headings)：按最浅级别对齐生成 "- 文本" 列表，每深一级缩进 2 空格（层级差 2 就缩进 4 空格）。
