// nailong/build/siliconflow.mjs — SiliconFlow（硅基流动）生图客户端。
//
// 只做两件事：探活/列模型，以及「给一张参考图 + 提示词 → 拿回一张图」。
// 生成结果直接落到 nailong/art/work/out/，交给现成的 art.mjs ingest 收料（尺寸/透明通道都在那一步统一处理）。
//
// 鉴权：**只从环境变量或 git 忽略的 .env 读**，绝不写进仓库。
//   PowerShell:  $env:SF_API_KEY = "sk-..."
//   或写到 nailong/.env（被根 .gitignore 的 .env 规则覆盖）：SF_API_KEY=sk-...
//
// 关于模型：SiliconFlow 的 /v1/images/generations 对「支持参考图」的模型（如 Qwen-Image-Edit 系列）
// 接受 image 字段，此时是 image-to-image（改图）；纯文生图模型（FLUX / Kolors / SD 系列）不接受 image。
// 战斗小人图集必须用参考图模型 —— 文生图会重画布局，图集坐标立刻失效。

import fs from 'node:fs';
import path from 'node:path';

export const API_BASE = 'https://api.siliconflow.cn';

/** 默认模型：支持参考图的改图模型，最贴合换皮场景。 */
export const DEFAULT_MODEL = 'Qwen/Qwen-Image-Edit';
/** 备选：纯文生图。 */
export const TEXT_ONLY_MODELS = Object.freeze([
  'Qwen/Qwen-Image', 'black-forest-labs/FLUX.1-schnell', 'Kwai-Kolors/Kolors',
]);
/** 已知支持 image 参考图的模型前缀。 */
const REF_MODEL_HINTS = ['Qwen/Qwen-Image-Edit', 'Qwen/Qwen-Image-Edit-2509', 'Qwen/Qwen-Image-Edit-'];

/** SiliconFlow 一般接受的 image_size 取值（按宽高比挑最接近的）。 */
const SIZE_PRESETS = Object.freeze([
  [1024, 1024], [768, 1024], [1024, 768], [720, 1280], [1280, 720],
  [768, 1344], [1344, 768], [512, 512], [384, 512], [512, 384],
]);

/** 按目标宽高比挑一个受支持的尺寸（找不到就退回最接近的方形）。 */
export function pickSize(width, height) {
  if (!width || !height) return '1024x1024';
  const want = width / height;
  let best = SIZE_PRESETS[0];
  let bestErr = Infinity;
  for (const [w, h] of SIZE_PRESETS) {
    const err = Math.abs(Math.log(w / h) - Math.log(want));
    if (err < bestErr) { bestErr = err; best = [w, h]; }
  }
  return best[0] + 'x' + best[1];
}

/** 该模型是否吃参考图。 */
export const modelSupportsRef = (model) => REF_MODEL_HINTS.some((p) => String(model).startsWith(p));

/** 从环境变量 / nailong/.env / 仓库根 .env 取 key，绝不入库。 */
export function resolveKey({ repoRoot, layerDir } = {}) {
  if (process.env.SF_API_KEY) return { key: process.env.SF_API_KEY.trim(), from: 'SF_API_KEY 环境变量' };
  const cands = [layerDir && path.join(layerDir, '.env'), repoRoot && path.join(repoRoot, '.env')].filter(Boolean);
  for (const abs of cands) {
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const m = /^\s*(?:export\s+)?(SF_API_KEY|SILICONFLOW_API_KEY)\s*=\s*(.+?)\s*$/.exec(line);
      if (m) return { key: m[2].replace(/^["']|["']$/g, ''), from: abs };
    }
  }
  return { key: null, from: null };
}

const mask = (k) => (k ? k.slice(0, 6) + '…' + k.slice(-4) + `（${k.length} 字符）` : '(无)');

/** 一次 HTTP，带超时与结构化错误。 */
async function post(pathname, key, body, { timeoutMs = 180000 } = {}) {
  const res = await fetch(API_BASE + pathname, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const msg = json?.message || text.slice(0, 200);
    const err = new Error(`HTTP ${res.status} ${json?.code != null ? 'code ' + json.code + ' ' : ''}${msg}`);
    err.status = res.status;
    err.code = json?.code;
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  return json;
}

/** 探活：列模型 + 判断 key 是否可用（不消耗额度）。 */
export async function probe({ key }) {
  const out = { key: mask(key), authOk: false, imageModels: [], error: null };
  if (!key) { out.error = '没有 key'; return out; }
  const get = async (q) => {
    const res = await fetch(API_BASE + '/v1/models' + q, { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(30000) });
    const t = await res.text();
    let j = null; try { j = JSON.parse(t); } catch { /* ignore */ }
    return { status: res.status, json: j, text: t };
  };
  try {
    const r = await get('?sub_type=text-to-image');
    if (r.status === 401 || r.json?.code === 30014) { out.error = 'Token is invalid（key 无效/已吊销）'; return out; }
    if (r.status !== 200) { out.error = `HTTP ${r.status} ${r.text.slice(0, 160)}`; return out; }
    out.authOk = true;
    out.imageModels = (r.json?.data ?? []).map((m) => m.id).filter(Boolean);
    for (const sub of ['image-to-image']) {
      const r2 = await get('?sub_type=' + sub);
      if (r2.status === 200) out.imageModels.push(...(r2.json?.data ?? []).map((m) => m.id).filter(Boolean));
    }
    out.imageModels = [...new Set(out.imageModels)];
    return out;
  } catch (e) {
    out.error = e.name + ': ' + ((e.cause && (e.cause.code || e.cause.message)) || e.message);
    return out;
  }
}

/** 读图 → data URL。 */
function dataUrl(abs) {
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
}

/**
 * 生成一张图。
 * @param {{ key: string, model?: string, prompt: string, negative?: string, refPath?: string,
 *           size?: string, steps?: number, guidance?: number, seed?: number, timeoutMs?: number }} opts
 * @returns {Promise<{ b64: string, mime: string, seed?: number, usage?: any }>}
 */
export async function generateImage(opts) {
  const model = opts.model || DEFAULT_MODEL;
  const body = {
    model,
    prompt: opts.prompt,
    image_size: opts.size || '1024x1024',
    batch_size: 1,
    num_inference_steps: opts.steps ?? 25,
    guidance_scale: opts.guidance ?? 4.5,
  };
  if (opts.negative) body.negative_prompt = opts.negative;
  if (opts.seed != null) body.seed = opts.seed;
  if (opts.refPath) {
    if (!modelSupportsRef(model)) throw new Error(`模型 ${model} 不支持参考图（image），换 Qwen/Qwen-Image-Edit 系列，或去掉 --ref`);
    body.image = dataUrl(opts.refPath);
  }
  const json = await post('/v1/images/generations', opts.key, body, { timeoutMs: opts.timeoutMs });
  // 兼容两种返回：{ images: [{url}] } 与 OpenAI 风格 { data: [{b64_json|url}] }
  const first = json?.images?.[0] ?? json?.data?.[0];
  if (!first) throw new Error('返回里没有图片：' + JSON.stringify(json).slice(0, 200));
  if (first.b64_json) return { b64: first.b64_json, mime: 'image/png', seed: json.seed, usage: json.usage };
  if (first.url) {
    const res = await fetch(first.url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error('下载生成结果失败：HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    return { b64: buf.toString('base64'), mime: res.headers.get('content-type') || 'image/png', seed: json.seed, usage: json.usage };
  }
  throw new Error('返回里的图片既没有 b64_json 也没有 url');
}
