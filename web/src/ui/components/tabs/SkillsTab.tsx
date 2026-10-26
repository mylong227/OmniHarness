// 技能目录：只读列出服务端技能（名称/描述/标签），供 `/` 选择器之外的可浏览入口。
import * as React from 'react';
import { useApp } from '../../context.ts';
import { t } from '../../i18n/i18n.ts';

/** 技能目录条目。 */
interface SkillRow {
  name: string;
  description: string;
  tags: string[];
}

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
          <ul className="act-list">
            {shown.map((skill) => (
              <li key={skill.name} className="act-item auto-skill">
                <span className="slash-name">/{skill.name}</span>
                <span className="act-text">{skill.description}</span>
                {skill.tags.length === 0 ? null : (
                  <span className="act-kind">{skill.tags.join(' · ')}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
