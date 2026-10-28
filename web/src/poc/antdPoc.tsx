// W0 PoC：antd 关键组件 × ThemeProvider 的隔离验证入口（不进主应用）。
//
// 目的（UI_LIBRARY_UPGRADE §7 W0）：
//   ① 验证 antd 6.6.8 + React 19.2 + Vite 构建链路可用（类型 / 运行时 / CSS 变量模式）；
//   ② 实测体积：vendor-antd 分块 gzip（web/dist-poc，主产物不受影响）；
//   ③ 密度样张：controlHeight 32 / fontSize 14 / 圆角 10·14·8 / 纸与墨 seed token；
//   ④ 双主题截图（?theme=dark|light）+ 暗色对比度结论。
//
// 该文件**不是**产品代码：W1 正式迁移开始后，PoC 入口与本文件按规划删除或降级为判据夹具。
// 函数体行数上限 80（门禁口径）⇒ 每个区块一个小组件。

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Alert,
  Button,
  DatePicker,
  Form,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Tree,
  type TableProps,
} from 'antd';
import { ThemeProvider } from '../ui/theme/ThemeProvider.tsx';
import type { ThemeName } from '../ui/theme/palette.ts';
// 纸与墨 token：PoC 页容器的底/边/字全部消费 theme.css 变量（与主应用同一事实源）。
// 注意 import 顺序即级联：theme 在前，poc 只做排版覆盖。
import '../../styles/theme.css';
import './poc.css';

/** 读 URL ?theme= 的初值（与 antd.html 内联脚本一致）。 */
function initialTheme(): ThemeName {
  return new URLSearchParams(window.location.search).get('theme') === 'light' ? 'light' : 'dark';
}

/** PoC 表格样例数据（少量，够看到表头/行密度/状态 Tag 即可）。 */
interface PoCRow {
  key: string;
  name: string;
  size: string;
  status: string;
}

const TABLE_DATA: PoCRow[] = [
  { key: '1', name: 'stepRunner.ts', size: '12.4 KB', status: 'ok' },
  { key: '2', name: 'agentResult.ts', size: '3.1 KB', status: 'warn' },
  { key: '3', name: 'resonantFieldEngine.ts', size: '31.8 KB', status: 'err' },
  { key: '4', name: 'subagentRunner.ts', size: '9.6 KB', status: 'ok' },
];

const TABLE_COLUMNS: TableProps<PoCRow>['columns'] = [
  { title: '文件', dataIndex: 'name' },
  { title: '大小', dataIndex: 'size', width: 100 },
  {
    title: '状态',
    dataIndex: 'status',
    width: 100,
    render: (v: string) =>
      v === 'ok' ? (
        <Tag color="success">正常</Tag>
      ) : v === 'warn' ? (
        <Tag color="warning">关注</Tag>
      ) : (
        <Tag color="error">失败</Tag>
      ),
  },
];

const TREE_DATA = [
  {
    title: 'web/src/ui',
    key: 'ui',
    children: [
      { title: 'theme/', key: 'ui-theme' },
      { title: 'kit/', key: 'ui-kit' },
      { title: 'components/', key: 'ui-components' },
    ],
  },
  {
    title: 'src/core',
    key: 'core',
    children: [{ title: 'agent.ts', key: 'core-agent' }],
  },
];

/** 页头 + 主题切换。 */
function PocHeader(props: { theme: ThemeName; onToggle: () => void }): React.ReactElement {
  return (
    <header className="poc-header">
      <div>
        <h1>antd 6.6.8 × 纸与墨 v2 · W0 PoC</h1>
        <p className="poc-note">隔离入口：实测体积 / 密度 / 双主题对比度；不影响主应用产物。</p>
      </div>
      <Space>
        <Button onClick={props.onToggle}>{props.theme === 'dark' ? '切到浅色' : '切到深色'}</Button>
      </Space>
    </header>
  );
}

/** Button 状态矩阵 + 密度样张。 */
function ButtonSection(): React.ReactElement {
  return (
    <section className="poc-section">
      <h2>Button / 密度</h2>
      <div className="poc-row">
        <Button type="primary">主行动</Button>
        <Button>默认</Button>
        <Button type="text">文本</Button>
        <Button type="link">链接</Button>
        <Button type="primary" loading>
          提交中
        </Button>
        <Button danger>危险</Button>
        <Button size="small">小号</Button>
        <Button size="large">大号</Button>
        <Tooltip title="antd Tooltip：白气泡口径（浅色纯白 / 深色墨片）">
          <Button>悬停有提示</Button>
        </Tooltip>
      </div>
    </section>
  );
}

/** 表格（small）与选择类输入。 */
function TableSelectSection(): React.ReactElement {
  return (
    <div className="poc-grid">
      <section className="poc-section">
        <h2>Table（small · 虚拟可开）</h2>
        <Table<PoCRow> size="small" columns={TABLE_COLUMNS} dataSource={TABLE_DATA} pagination={false} />
      </section>
      <section className="poc-section">
        <h2>Select / DatePicker</h2>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Select
            style={{ width: '100%' }}
            defaultValue="balanced"
            options={[
              { value: 'balanced', label: 'balanced（默认）' },
              { value: 'quality', label: 'quality（高质量）' },
              { value: 'fast', label: 'fast（低延迟）' },
            ]}
          />
          <DatePicker style={{ width: '100%' }} />
          <Space>
            <Switch defaultChecked />
            <Progress percent={72} size="small" style={{ width: 160 }} />
            <Tag>审计链</Tag>
          </Space>
        </Space>
      </section>
    </div>
  );
}

/** 表单样例。 */
function FormSection(): React.ReactElement {
  return (
    <section className="poc-section">
      <h2>Form + DatePicker</h2>
      <Form layout="vertical" size="middle">
        <Form.Item label="会话名" required>
          <Input placeholder="输入会话名…" />
        </Form.Item>
        <Form.Item label="模型">
          <Select
            options={[
              { value: 'glm', label: 'GLM' },
              { value: 'claude', label: 'Claude' },
            ]}
          />
        </Form.Item>
        <Form.Item label="归档日期">
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
        <Button type="primary">保存</Button>
      </Form>
    </section>
  );
}

/** 树 + 模态 + 标签页样例（Modal 状态自持）。 */
function TreeModalTabsSection(): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <section className="poc-section">
      <h2>Tree / Modal / Tabs</h2>
      <Tree defaultExpandAll treeData={TREE_DATA} />
      <Space style={{ marginTop: 12 }}>
        <Button type="primary" onClick={() => setOpen(true)}>
          打开 Modal
        </Button>
      </Space>
      <Modal
        title="审批请求（样例）"
        open={open}
        onOk={() => setOpen(false)}
        onCancel={() => setOpen(false)}
        okText="批准"
        cancelText="拒绝"
      >
        <p>Modal 内容区：contentBg=panel、圆角 14、遮罩沿用 rgba(10,12,16,.62)。</p>
        <Alert type="info" showIcon message="焦点圈禁与 Esc 语义由 antd 承担。" />
      </Modal>
      <Tabs
        style={{ marginTop: 8 }}
        items={[
          { key: 'a', label: '对话', children: <p style={{ margin: '8px 0' }}>标签页内容 A</p> },
          { key: 'b', label: '轨迹', children: <p style={{ margin: '8px 0' }}>标签页内容 B</p> },
        ]}
      />
    </section>
  );
}

/** PoC 页面主体。 */
function PocPage(): React.ReactElement {
  const [theme, setTheme] = React.useState<ThemeName>(initialTheme);
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    setTheme(next);
  };
  return (
    <ThemeProvider theme={theme}>
      <div className="poc">
        <PocHeader theme={theme} onToggle={toggleTheme} />
        <ButtonSection />
        <TableSelectSection />
        <div className="poc-grid">
          <FormSection />
          <TreeModalTabsSection />
        </div>
      </div>
    </ThemeProvider>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<PocPage />);
}
