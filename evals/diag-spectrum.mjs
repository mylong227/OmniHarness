// 同 corpus 频谱开关隔离对照（诚实性收口）：
// 在 FULL corpus（symbolSpectra 非空）上，仅切换 symbolSpectra 的开/关，
// 其余（graph/lsa 关、同一 query 路径）完全不变 —— 这才是频谱对文件召回的真实增量。
// 注：tmp_diag_spectrum.mjs 误在 light corpus 上做此对照（light 下 spectra 恒空），属空实验，已废。
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const D = (...p) => pathToFileURL(join(__dirname, 'dist', 'src', ...p)).href;
const { indexCorpus, query } = await import(D('context', 'contextEngine.js'));
const SRC = join(__dirname, 'src');

// 与主 eval 完全一致的 33 个锚点（保证 GT 口径一致）。
const QUERIES = [
  ['where is tool registration handled', 'registerTool'],
  ['how does sandbox denial escalate to approval', 'EscalationPort'],
  ['what does ContextAssembler project events into', 'class ContextAssembler'],
  ['how are images attached to model messages', 'imagesOf'],
  ['where is reasoning_effort sent to the openai model', 'reasoning_effort'],
  ['how does BM25 tokenize CJK text', 'public static tokenize'],
  ['how is the resonant memory probe mapped from text', 'resonateByText'],
  ['where is the sandbox policy evaluated', 'execPolicy'],
  ['how are tool results spilled out of context', 'spill_read'],
  ['which component remembers decisions the operator already blessed', 'ApprovalStore'],
  ['how is a signed claim from an agent packaged', 'AgentAssertionEnvelope'],
  ['which key-value store replicates records across nodes', 'OobleckStore'],
  ['tuning knobs for the graph that links distant memories', 'ResonantFieldOptions'],
  ['settings for the planner that gradually cools down', 'HeatAnnealerOptions'],
  ['options controlling what gets pulled out of conversations', 'MemoryExtractorOptions'],
  ['knobs for the parity based error correction layer', 'QECOptions'],
  ['what signals that a parity check has failed', 'Syndrome'],
  ['where is the remaining spend captured at a point in time', 'BudgetSnapshot'],
  ['how is a chain of thought persisted to disk', 'StoredTrace'],
  ['what normalizes text before it is compared', 'Canonicalizer'],
  ['how long is a prior yes remembered before asking again', 'CachedApprovalOptions'],
  ['settings for the belief updater that follows curvature', 'NaturalGradientOptions'],
  ['tunables for the sampler tracking many hypotheses at once', 'ParticleFilterOptions'],
  ['how is the local vector model configured', 'TransformersEmbeddingOptions'],
  ['where are ed25519 signing credentials created', 'KeyPairSync'],
  ['how are orphaned tool call identifiers tracked', 'ToolCallRef'],
  ['how is the chat completion provider configured', 'OpenAiModelConfig'],
  ['where do language server error reports come from', 'Diagnostics'],
  ['how many characters of a conversation are retained', 'TranscriptChars'],
  ['what does a delegated child task return', 'SubagentResult'],
  ['what represents one entry in a multi stage plan', 'PlanStep'],
  ['where are capabilities discovered and registered', 'SkillRegistry'],
  ['which component gates dangerous tool calls at runtime', 'SupervisorKernel'],
];

function groundTruth(corpus, anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) if (text.toLowerCase().includes(needle)) set.add(rel);
  return set;
}

const c = indexCorpus(SRC, { morph: true, light: false });
console.log(
  `full corpus: files=${c.files.length} sym=${c.symbols.length} spectra=${c.symbolSpectra.length}`,
);

function recallWith(spectraOn) {
  // 同 corpus 仅切 symbolSpectra。
  c.symbolSpectra = spectraOn ? c.symbolSpectra : [];
  let s = 0;
  let zeroGt = 0;
  for (const [q, anchor] of QUERIES) {
    const gt = groundTruth(c, anchor);
    if (gt.size === 0) {
      zeroGt++;
      continue;
    }
    const res = query(c, q, { graph: false, lsa: false, fileK: 14, symK: 24 });
    const surf = new Set(res.files);
    s += [...gt].filter((f) => surf.has(f)).length / gt.size;
  }
  const denom = QUERIES.length - zeroGt;
  return { avg: ((s / denom) * 100).toFixed(1), denom, zeroGt };
}

const on = recallWith(true);
const off = recallWith(false);
console.log(`FULL corpus 频谱ON  文件召回 = ${on.avg}%  (n=${on.denom})`);
console.log(`FULL corpus 频谱OFF 文件召回 = ${off.avg}%  (n=${off.denom})`);
console.log(
  `频谱同 corpus 净效应 = ${(Number(on.avg) - Number(off.avg)).toFixed(1)}pp  → ${Math.abs(Number(on.avg) - Number(off.avg)) < 0.05 ? '纯零效应' : Number(on.avg) > Number(off.avg) ? '正' : '负'}`,
);
