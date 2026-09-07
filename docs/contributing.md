# 贡献指南

## 铁律（不可妥协）

- 代码用 TypeScript（`src/`），ESM，严格模式
- **一个功能一个类**；**一个函数一个职责**；禁止大函数
- **文件命名一律 camelCase（驼峰），拒绝下划线与连字符**
- **零运行时依赖**（仅 devDeps: typescript + @types/node）
- 核心只依赖端口接口，不依赖具体实现

## 开发流程

```bash
npm install
npm run build      # tsc 构建
npm test           # 单元测试（node:test，零依赖）
npm run smoke      # 冒烟（4 组）
npm run stress     # 压测（内存泄漏检查）
```

## 添加新功能

1. 判断功能归属：端口？适配器？核心？扩展层？
2. 新增文件遵循 camelCase 命名；一个功能一个类
3. 补单元测试（tests/unit/）
4. 跑 `npm test` + `npm run smoke` 回归，确认不破坏既有功能
5. 更新 README / 对应 docs

## 修改端口

端口接口在 `src/ports/`。修改端口 = 破坏性变更：

- 新能力用**可选方法**（如 `stream?`）避免破坏既有实现
- 若必须加必需方法，同步更新全部内置适配器
- 更新架构文档 `docs/architecture.md`

## 提交规范

- 提交信息：`类型: 简述`（feat/fix/docs/refactor/test/chore）
- 每步一个提交，保持历史可读
