"""把一个判据文件从 `web`（桩）项目移到 `web-rtl`（真实 React）项目。

用法：python scripts/_moveToRtl.py <文件名不含 .test.ts，可多个>
"""

import io
import re
import sys

P = 'vitest.workspace.ts'
t = io.open(P, encoding='utf-8').read()

names = sys.argv[1:]
assert names, '需要至少一个文件名'

# 现有 exclude / include 列表
m_ex = re.search(r"exclude: \[([^\]]*)\],", t)
m_in = re.search(r"include: \[([^\]]*)\],\n      environment: 'jsdom'", t)
assert m_ex and m_in, '未找到 web / web-rtl 的 include/exclude'

ex_items = [x.strip().strip("'") for x in m_ex.group(1).split(',') if x.strip()]
in_items = [x.strip().strip("'") for x in m_in.group(1).split(',') if x.strip()]

for n in names:
    path = f'web/test/{n}.test.ts'
    if path not in in_items:
        in_items.append(path)
    if path not in ex_items:
        ex_items.append(path)

fmt = lambda items: ', '.join(f"'{i}'" for i in sorted(items))
t = t[:m_ex.start(1)] + fmt(ex_items) + t[m_ex.end(1):]
m_in = re.search(r"include: \[([^\]]*)\],\n      environment: 'jsdom'", t)
t = t[:m_in.start(1)] + fmt(in_items) + t[m_in.end(1):]

io.open(P, 'w', encoding='utf-8', newline='\n').write(t)
print(f'已移入 web-rtl：{" ".join(names)}（当前 RTL {len(in_items)} 个文件）')
