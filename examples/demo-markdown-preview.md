# Demo 插件 README

一个自包含、可端到端验证的 demo 插件。

## 安装

```bash
npm install demo-calc
```

## API 一览

| 函数    | 参数   | 返回值   | 说明     |
| ------- | ------ | -------- | -------- |
| `add`   | `a, b` | `number` | 两数相加 |
| `mul`   | `a, b` | `number` | 两数相乘 |
| `greet` | `name` | `string` | 打招呼   |

## 使用示例

```js
import { add, mul } from 'demo-calc';
console.log(add(2, 3)); // 5
console.log(mul(4, 5)); // 20
```

> 提示：右侧面板已支持 markdown 渲染（标题 / 表格 / 代码块 / 引用）。

## 特性清单

- 零运行时依赖
- TypeScript 编写，类型安全
- 附带单元测试

---

### 修改记录

1. 2026-09-08：创建 v0.1.0
2. 后续：见 CHANGELOG.md
