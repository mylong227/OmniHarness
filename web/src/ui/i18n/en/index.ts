// en 词条聚合：把各分片合为一张总表供 i18n.t 查询。新增分片在此登记一次即可。
import { EN_COMPOSER } from './composer.js';
import { EN_FILES } from './files.js';
import { EN_MISC } from './misc.js';
import { EN_MODELS_MISC } from './models_misc.js';
import { EN_SESSIONS } from './sessions.js';
import { EN_SETTINGS } from './settings.js';
import { EN_SHELL } from './shell.js';
import { EN_STREAM } from './stream.js';
import { EN_TABS_A } from './tabs_a.js';
import { EN_TABS_B } from './tabs_b.js';

/** en 词条总表。键 = 中文原文；缺词条时 t() 回落中文原文（完整性由 i18nCoverage 测试兜底）。 */
export const EN: Record<string, string> = {
  ...EN_COMPOSER,
  ...EN_FILES,
  ...EN_MISC,
  ...EN_MODELS_MISC,
  ...EN_SESSIONS,
  ...EN_SETTINGS,
  ...EN_SHELL,
  ...EN_STREAM,
  ...EN_TABS_A,
  ...EN_TABS_B,
};
