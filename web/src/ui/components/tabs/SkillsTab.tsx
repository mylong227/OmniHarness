// 技能目录：只读列出服务端技能（名称/描述/标签），供 `/` 选择器之外的可浏览入口。
import * as React from 'react';
import { useApp } from '../../context.ts';
import { t } from '../../i18n/i18n.ts';
// 面板级 antd 一律子路径导入（不走 'antd' 桶文件，理由见 vite.config.ts「分块改造」注释）。
import Table from 'antd/es/table';
import type { ColumnsType } from 'antd/es/table';
import Tag from 'antd/es/tag';

/** 技能目录条目。 */
interface SkillRow {
  name: string;
  description: string;
  tags: string[];
}


/** 技能目录列定义（2026-10-30 W4：act-list → antd Table，标签用 antd Tag）。 */
const skillColumns: ColumnsType<SkillRow> = [
  {
    title: t('技能'),
    dataIndex: 'name',
    key: 'name',
    width: 200,
    render: (name: string) => <span className="slash-name">/{name}</span>,
  },
  { title: t('描述'), dataIndex: 'description', key: 'description' },
  {
    title: t('标签'),
    dataIndex: 'tags',
    key: 'tags',
    width: 200,
    render: (tags: string[]) => (tags.length === 0 ? null : tags.map((tg) => <Tag key={tg}>{tg}</Tag>)),
  },
];

/** 技能面板。 */
export function SkillsTab(): React.ReactElement {
  const { api } = useApp();
  const [skills, setSkills] = React.useState<SkillRow[] | null>(null);
  const [error, setError] = React.useState('');
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    api
      .listSkills()
      .then((r) => {
        if (alive) setSkills(r.skills ?? []);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, [api]);

  if (error !== '') {
    return <p className="act-error" role="alert">{t('读取技能失败：{msg}', { msg: error })}</p>;
  }
  if (skills === null) return <p className="act-muted">{t('读取中…')}</p>;

  const q = query.trim().toLowerCase();
  const shown =
    q === ''
      ? skills
      : skills.filter((s) =>
          [s.name, s.description, ...s.tags].join(' ').toLowerCase().includes(q),
        );

  return (
    <div className="act">
      <section className="act-card">
        <div className="pm-head">
          <input
            className="sp-input"
            value={query}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
            placeholder={t('搜索技能')}
            aria-label={t('搜索技能')}
          />
        </div>
        {shown.length === 0 ? (
          <p className="act-muted">{t('没有匹配的技能')}</p>
        ) : (
          <Table<SkillRow>
            className="skills-table"
            size="small"
            bordered={false}
            pagination={false}
            columns={skillColumns}
            dataSource={[...shown]}
            rowKey="name"
            scroll={{ x: 'max-content' }}
          />
        )}
      </section>
    </div>
  );
}
