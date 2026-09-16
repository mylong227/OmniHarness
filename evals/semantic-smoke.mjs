/**
 * 语义嵌入冒烟测试：验证 transformers.js 能否经 hf-mirror 下载并运行 ONNX 嵌入模型。
 *
 * 背景：`env.remoteHost` 默认 https://huggingface.co/（本沙箱不可达），
 * 且 transformers.js 4.2.0 **不读** HF_ENDPOINT 环境变量 ⇒ 必须显式指向镜像。
 *
 * 用法：
 *   OMNI_HF_ENDPOINT=https://hf-mirror.com \
 *   node evals/semantic-smoke.mjs [model] [cacheDir]
 */
import { env, pipeline } from '@huggingface/transformers';

const MODEL = process.argv[2] ?? 'Xenova/e5-small-v2';
const CACHE = process.argv[3] ?? 'D:/deepseek/.omni-model-cache';
const HOST = process.env.OMNI_HF_ENDPOINT ?? 'https://hf-mirror.com';

env.remoteHost = HOST;
env.cacheDir = CACHE;
env.allowLocalModels = true;
env.allowRemoteModels = true;

console.log(`[smoke] model      = ${MODEL}`);
console.log(`[smoke] remoteHost = ${env.remoteHost}`);
console.log(`[smoke] cacheDir   = ${env.cacheDir}`);

const t0 = Date.now();
const pipe = await pipeline('feature-extraction', MODEL, { device: 'cpu', dtype: 'q8' });
console.log(`[smoke] pipeline ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const texts = [
  'query: where is the chain of thought persisted to disk',
  'passage: class StoredTrace writes the reasoning trace to a jsonl file',
  'passage: class ColorPalette normalizes hex codes for the theme',
];
const t1 = Date.now();
const out = await pipe(texts, { pooling: 'mean', normalize: true });
const mat = out.tolist();
console.log(`[smoke] embedded ${texts.length} texts in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
console.log(`[smoke] dims = ${JSON.stringify(out.dims)}`);

/** 余弦相似度（已归一化时即点积）。 */
function cos(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
const hit = cos(mat[0], mat[1]);
const miss = cos(mat[0], mat[2]);
console.log(`[smoke] cos(query, StoredTrace)  = ${hit.toFixed(4)}`);
console.log(`[smoke] cos(query, ColorPalette) = ${miss.toFixed(4)}`);
console.log(
  `[smoke] 语义区分度 gap = ${(hit - miss).toFixed(4)} ${hit - miss > 0.05 ? 'OK 有区分力' : 'FAIL 区分力不足'}`,
);
