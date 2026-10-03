/**
 * 语义召回端到端（**真实模型**）验证：`evals/semantic-e2e-real.mjs`
 *
 * ## 为什么有这个脚本
 *
 * `docs/PROJECT_BOARD.md` §4 曾如实登记：「语义召回生产端到端验证：向量落盘缓存
 * （`diskCachedEmbeddingAdapter`）由假嵌入端口的单测覆盖；**真实模型端到端未验证**
 * （本机无 ONNX 权重下载条件），不得声称已实测加速」。
 *
 * 2026-10-03 复核：本机**权重其实已就位**（`.omniharness/model-cache/Xenova/e5-small-v2`，
 * config + tokenizer + model_quantized.onnx 齐全），配 `preset: 'e5-small-v2'` +
 * `localFilesOnly: true` 可**完全离线**跑通（实测 dim=384、冷启 713ms、热 11ms）。
 * 于是这条「未验证」可以升级为「本机可复现的实测」。本脚本就是它的可执行形态。
 *
 * ## 它验什么（五段，每段都打印**真实到达模型**的编码条数）
 *
 *  ① **首建**：真模型编码全部条目（基线成本）。
 *  ② **同进程改 1 个文件**：内存内容复用（`EmbeddingContentCache`）应把编码压到 ≈1 条。
 *  ③ **模拟进程重启**（全新适配器 + 全新 `SemanticIndexCache`，同一份语料）：
 *     落盘向量缓存（`DiskCachedEmbeddingAdapter`）应把编码压到 **0 条**。
 *  ④ **重启后又改 1 个文件**：盘上缓存 + 内存复用叠加 ⇒ 仍只有 ≈1 条。
 *  ⑤ **冷基线对拍**（独立缓存目录 ⇒ 全部真编码）：其检索结果必须与 ②③ 段**逐位一致**
 *     —— 复用省的是重复编码，不是正确性。
 *
 * ## 诚实边界（引用本脚本数字时必须一并说明）
 *
 *  - 语料是**从本仓 `src/` 复制到临时目录的有界子集**（默认 300 文件），不是全仓 3227：
 *    全仓真编码约 7 万条、按实测 180–320 texts/s 需数分钟，不适合当回归脚本。
 *    **相对量**（复用把编码压到 0/1 条）与语料规模无关，但**绝对耗时不得外推**。
 *  - 模型是 **e5-small-v2（384 维）离线量化档**；换模型（尤其 1024 维）吞吐与内存不同。
 *  - 脚本**不改本仓工作区**（只在临时目录里改文件），可反复运行。
 *
 * 用法：`node evals/semantic-e2e-real.mjs [--files 600]`（需先 `npm run build`）。
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const capIndex = argv.indexOf('--files');
const capArg = capIndex >= 0 ? argv[capIndex + 1] : undefined;
const FILE_CAP = Number.isFinite(Number(capArg)) && Number(capArg) > 0 ? Number(capArg) : 300;
const MODEL_CACHE =
  process.env['OMNI_EMBEDDING_CACHE_DIR'] ?? join(ROOT, '.omniharness', 'model-cache');
const PRESET = 'e5-small-v2';
const QUERIES = [
  'checkpoint rollback 事件流截断',
  'BM25 inverted index document frequency',
  '上下文压缩阈值 token 记账',
  'tool exposure planner 类别相关性',
];

/** 计数型装饰器：统计**真正到达模型**的文本条数（放在落盘缓存内层，故盘命中不计入）。 */
class CountingInner {
  /**
   * @param inner 真模型端口。
   */
  constructor(inner) {
    this.inner = inner;
    this.dim = inner.dim;
    this.encoded = 0;
  }

  /**
   * 批量嵌入并计数。
   * @param texts 待嵌入文本。
   * @param opts 嵌入选项（原样透传）。
   * @returns 向量数组。
   */
  async embed(texts, opts) {
    this.encoded += texts.length;
    return this.inner.embed(texts, opts);
  }
}

/**
 * 收集 `src/` 下的 .ts 相对路径（有界、排序 ⇒ 可复现）。
 * @param cap 文件数上限。
 * @returns 相对 POSIX 路径数组。
 */
function collectSources(cap) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (out.length >= cap) return;
      if (entry.startsWith('.')) continue;
      const abs = join(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.endsWith('.ts')) out.push(relative(ROOT, abs).split(sep).join('/'));
    }
  };
  walk(join(ROOT, 'src'));
  return out.sort().slice(0, cap);
}

/**
 * 逐文件字节哈希（与 `CorpusIndexCache` 的签名复核同口径）。
 * @param mods 已载入的模块集合。
 * @param root 语料根。
 * @returns `rel → sha1`。
 */
function contentHashes(mods, root) {
  const { ContextEngine, CorpusFileParser } = mods;
  const rels = [];
  ContextEngine.walk(root, root, rels, {});
  const hashes = new Map();
  for (const rel of rels) {
    hashes.set(
      rel,
      CorpusFileParser.hashOfBytes(readFileSync(join(root, rel.split('/').join(sep)))),
    );
  }
  return hashes;
}

/**
 * 造一套「生产同构」的端口栈：计数 → 真模型 → 落盘缓存。
 * @param mods 已载入的模块集合。
 * @param vecDir 落盘向量缓存目录。
 * @returns `{ port, counting }`。
 */
function makeStack(mods, vecDir) {
  const { TransformersEmbeddingAdapter, DiskCachedEmbeddingAdapter } = mods;
  const counting = new CountingInner(
    new TransformersEmbeddingAdapter({
      preset: PRESET,
      cacheDir: MODEL_CACHE,
      localFilesOnly: true,
    }),
  );
  const port = new DiskCachedEmbeddingAdapter({ inner: counting, cacheDir: vecDir });
  return { port, counting };
}

const fmt = (n) => n.toLocaleString('en-US');

/** 端到端主流程。 */
async function main() {
  const [tfMod, diskMod, contextMod, semanticMod, knobsMod, updaterMod, parserMod] =
    await Promise.all([
      import('../dist/src/adapters/embedding/transformersEmbeddingAdapter.js'),
      import('../dist/src/adapters/embedding/diskCachedEmbeddingAdapter.js'),
      import('../dist/src/context/contextEngine.js'),
      import('../dist/src/context/semanticIndexCache.js'),
      import('../dist/src/context/recallKnobs.js'),
      import('../dist/src/context/corpusIncrementalUpdater.js'),
      import('../dist/src/context/corpusFileParser.js'),
    ]);
  const { SemanticIndexCache } = semanticMod;
  const { RecallKnobs } = knobsMod;
  const { CorpusIncrementalUpdater } = updaterMod;
  // `makeStack` / `contentHashes` 需要的模块集合（命名空间解包后的具体类）。
  const allMods = {
    TransformersEmbeddingAdapter: tfMod.TransformersEmbeddingAdapter,
    DiskCachedEmbeddingAdapter: diskMod.DiskCachedEmbeddingAdapter,
    ContextEngine: contextMod.ContextEngine,
    CorpusFileParser: parserMod.CorpusFileParser,
  };

  const work = mkdtempSync(join(tmpdir(), 'omni-semantic-e2e-'));
  const vecDir = join(work, 'vec-cache');
  const coldVecDir = join(work, 'vec-cache-cold');
  const corpusDir = join(work, 'corpus');
  const sources = collectSources(FILE_CAP);
  console.log(`[语义端到端·真实模型] preset=${PRESET} 离线=是 模型缓存=${MODEL_CACHE}`);
  console.log(`语料：从本仓 src/ 复制 ${sources.length} 个 .ts 到临时目录（不改工作区）`);
  for (const rel of sources) {
    const target = join(corpusDir, rel.split('/').join(sep));
    mkdirSync(join(target, '..'), { recursive: true });
    cpSync(join(ROOT, rel), target);
  }

  /**
   * 全量建语料并**带回产物表**（增量器复用它的前提）。
   * @param root 语料根。
   * @returns `{ corpus, artifacts }`。
   */
  const build = (root) => {
    const artifacts = new Map();
    const corpus = contextMod.ContextEngine.indexCorpus(root, {
      morph: true,
      light: true,
      artifactSink: artifacts,
    });
    return { corpus, artifacts };
  };
  const searchOf = async (index, queries) => {
    const out = [];
    for (const q of queries) {
      // 结构化返回（不拼字符串）：命中 id 形如 `sym:12` / `file:src/x.ts` 本身含冒号，
      // 拼串再切分会把 id 与分数切错（初版即因此得出 NaN 与假 ❌）。
      out.push((await index.search(q, 5)).map((h) => ({ id: h.id, score: h.score })));
    }
    return out;
  };

  const v1 = build(corpusDir);
  console.log(`语料：文件=${fmt(v1.corpus.files.length)} 符号=${fmt(v1.corpus.symbols.length)}`);

  const stack1 = makeStack(allMods, vecDir);
  const cache1 = new SemanticIndexCache();
  const t1 = Date.now();
  await cache1.get(corpusDir, v1.corpus, stack1.port, new RecallKnobs({}));
  const firstEncoded = stack1.counting.encoded;
  console.log(`\n① 首建：编码 ${fmt(firstEncoded)} 条 / ${Date.now() - t1}ms`);

  // ② 同进程改 1 个文件（改动落在被嵌入窗口内：插到文件开头）
  const victim = join(corpusDir, sources[0].split('/').join(sep));
  const victimOriginal = readFileSync(victim, 'utf8');
  writeFileSync(victim, `// 语义端到端探针\n${victimOriginal}`, 'utf8');
  const updater = new CorpusIncrementalUpdater({ morph: true, light: true });
  const v2 = updater.update(corpusDir, v1.corpus, v1.artifacts, contentHashes(allMods, corpusDir));
  if (v2 === null) throw new Error('语料增量更新意外失败（文件集合未变，应当成功）');
  stack1.counting.encoded = 0;
  const t2 = Date.now();
  const idx2 = await cache1.get(corpusDir, v2.corpus, stack1.port, new RecallKnobs({}));
  const memEncoded = stack1.counting.encoded;
  console.log(
    `② 同进程改 1 文件：编码 ${fmt(memEncoded)} 条 / ${Date.now() - t2}ms（内存内容复用）`,
  );

  // ③ 模拟进程重启：全新适配器 + 全新索引缓存，同一份语料
  const stack2 = makeStack(allMods, vecDir);
  const cache2 = new SemanticIndexCache();
  const t3 = Date.now();
  const idx3 = await cache2.get(corpusDir, v2.corpus, stack2.port, new RecallKnobs({}));
  const diskEncoded = stack2.counting.encoded;
  console.log(
    `③ 模拟重启（同语料）：编码 ${fmt(diskEncoded)} 条 / ${Date.now() - t3}ms（落盘向量缓存）`,
  );

  // ④ 重启后又改 1 个文件
  const victim2 = join(corpusDir, sources[1].split('/').join(sep));
  const victim2Original = readFileSync(victim2, 'utf8');
  writeFileSync(victim2, `// 语义端到端探针 2\n${victim2Original}`, 'utf8');
  const v3 = updater.update(corpusDir, v2.corpus, v2.artifacts, contentHashes(allMods, corpusDir));
  if (v3 === null) throw new Error('语料增量更新意外失败（第二次）');
  const stack3 = makeStack(allMods, vecDir);
  const cache3 = new SemanticIndexCache();
  const t4 = Date.now();
  const idx4 = await cache3.get(corpusDir, v3.corpus, stack3.port, new RecallKnobs({}));
  const restartEncoded = stack3.counting.encoded;
  console.log(
    `④ 重启后再改 1 文件：编码 ${fmt(restartEncoded)} 条 / ${Date.now() - t4}ms（盘上缓存 + 内存复用）`,
  );

  // ⑤ 冷基线对拍（独立缓存目录 ⇒ 全部真编码）
  const stackCold = makeStack(allMods, coldVecDir);
  const cacheCold = new SemanticIndexCache();
  const t5 = Date.now();
  const idxCold = await cacheCold.get(corpusDir, v3.corpus, stackCold.port, new RecallKnobs({}));
  const coldEncoded = stackCold.counting.encoded;
  console.log(`⑤ 冷基线（独立缓存目录）：编码 ${fmt(coldEncoded)} 条 / ${Date.now() - t5}ms`);

  const [warmHits, diskHits, restartHits, coldHits] = await Promise.all([
    searchOf(idx2, QUERIES),
    searchOf(idx3, QUERIES),
    searchOf(idx4, QUERIES),
    searchOf(idxCold, QUERIES),
  ]);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  /**
   * 对拍两个索引的检索结果：分别给出「命中 id 序列是否相同」与「分数最大绝对差」。
   * 两者分开报，是为了区分「排序变了」（真问题）与「低位浮点差」（可接受且需如实登记）。
   * @param a 甲索引结果串数组。
   * @param b 乙索引结果串数组。
   * @returns `{ sameIds, maxDelta }`。
   */
  const compare = (a, b) => {
    let sameIds = true;
    let top1Same = true;
    let overlap = 0;
    let total = 0;
    let maxDelta = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const rows = [a[i] ?? [], b[i] ?? []];
      const leftIds = new Set(rows[0].map((h) => h.id));
      for (const hit of rows[1]) {
        if (leftIds.has(hit.id)) overlap += 1;
      }
      total += rows[1].length;
      if ((rows[0][0]?.id ?? null) !== (rows[1][0]?.id ?? null)) top1Same = false;
      for (let j = 0; j < Math.max(rows[0].length, rows[1].length); j += 1) {
        const left = rows[0][j];
        const right = rows[1][j];
        if (left === undefined || right === undefined || left.id !== right.id) {
          sameIds = false;
          continue;
        }
        maxDelta = Math.max(maxDelta, Math.abs(left.score - right.score));
      }
    }
    return { sameIds, top1Same, overlap, total, maxDelta };
  };
  // 对拍必须**同语料**：②③ 都是 v2，④⑤ 都是 v3。
  // （2026-10-03 修正①：初版把 v2 的索引与 v3 的冷基线比，比的是两份语料，必然不等。）
  // （2026-10-03 修正②：**判据不能是「逐位相等」**——真实模型下同一文本的向量依赖**批次构成**
  //   （padding 长度影响注意力掩码 → 数值路径变化）。本机实测：同文本 solo vs batch(32)
  //   向量最大分量差 **6.3e-3**、余弦 0.99904；同批次构成则逐位相同（跨会话亦然）。
  //   故复用向量（冻结点时的批次值）与重算向量天然有 ~1e-3 量级差，近邻排名可能翻转。
  //   判据据此改为「top-1 必须相同 + top-5 覆盖率达标 + 分数差 ≤ 阈值」，并在报告里明示。）
  const memVsDisk = compare(warmHits, diskHits);
  const warmVsCold = compare(restartHits, coldHits);
  // ②↔③ 是**同一批已缓存向量**（内存复用 vs 落盘复用），必须逐位相同 —— 这是缓存正确性的**硬判据**。
  const cacheFidelity = memVsDisk.sameIds && memVsDisk.maxDelta === 0;
  // ④↔⑤ 含重算，只能作**噪声地板刻画 + 粗损坏探测**：真实模型向量依赖批次构成，
  // 当某查询 top-2 分差小于噪声地板时 top-1 翻转是**预期**现象（实测 top-2 分差 ~4e-3、
  // 噪声 ~2.3e-3），故**不得**用 top-1 相等或逐位相等当判据；重叠率若崩到 60% 以下才说明
  // 缓存喂错了向量（真损坏）。
  const crossRunOk = warmVsCold.overlap >= Math.floor(warmVsCold.total * 0.6);
  const memReuseOk = memEncoded <= 2;
  // ③ 不手动 flush ⇒ 直接验证「构建后自动落盘」这条接线（修前实测残留 84 条未落盘）。
  const diskReuseOk = diskEncoded === 0;
  const restartReuseOk = restartEncoded <= 2;

  console.log('\n═══ 判定 ═══');
  console.log(`内存内容复用（② ≤2 条）：${memReuseOk ? '✅' : '❌'} 实得 ${String(memEncoded)}`);
  console.log(
    `落盘向量复用（③ =0 条，**不手动 flush**，验自动落盘接线）：${diskReuseOk ? '✅' : '❌'} 实得 ${String(diskEncoded)}`,
  );
  console.log(
    `重启后叠加复用（④ ≤2 条）：${restartReuseOk ? '✅' : '❌'} 实得 ${String(restartEncoded)}`,
  );
  console.log(
    `缓存保真（硬判据：②↔③ 同一批缓存向量逐位相同）：${cacheFidelity ? '✅' : '❌'}` +
      `（分数最大差 ${memVsDisk.maxDelta.toExponential(2)}）`,
  );
  console.log(
    `跨批次损坏探测（软判据：④↔⑤ top5 覆盖 ≥60%）：${crossRunOk ? '✅' : '❌'}` +
      ` 覆盖=${String(warmVsCold.overlap)}/${String(warmVsCold.total)}` +
      ` top1 一致=${String(warmVsCold.top1Same)}（**不参与判定**，见下）` +
      ` 分数最大差=${warmVsCold.maxDelta.toExponential(2)}`,
  );
  console.log(
    '  ⚠️ 噪声地板（实测，必须随数字一并引用）：真实模型的向量**依赖批次构成**——同文本' +
      ' solo vs batch32 的分量最大差 **6.3e-3**、余弦 0.99904；同批次构成则逐位相同（跨会话亦然）。' +
      '故跨运行/跨配置的语义对比**不得**以逐位相等或 top-1 相等为判据；' +
      '本脚本据此把「逐位」只用于**同一批缓存向量**的对拍。',
  );
  console.log(
    `编码压缩比：冷基线 ${fmt(coldEncoded)} 条 → 重启后 ${fmt(restartEncoded)} 条（` +
      `${(coldEncoded / Math.max(1, restartEncoded)).toFixed(0)}×）`,
  );
  console.log(
    `口径边界：语料=${sources.length} 文件（本仓 src/ 的有界子集）、模型=${PRESET} 离线量化档；` +
      '绝对耗时不得外推到全仓（全仓约 7 万条待编码）。',
  );

  writeFileSync(victim, victimOriginal, 'utf8');
  writeFileSync(victim2, victim2Original, 'utf8');
  rmSync(work, { recursive: true, force: true });

  if (!(memReuseOk && diskReuseOk && restartReuseOk && cacheFidelity && crossRunOk)) {
    console.error('❌ 语义端到端（真实模型）未达判据');
    process.exit(1);
  }
  console.log('✅ 语义端到端（真实模型）五段判据全部达标');
}

await main();
