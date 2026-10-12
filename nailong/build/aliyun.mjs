// nailong/build/aliyun.mjs — 阿里云百炼（Model Studio / Token Plan）生图客户端。
//
// 两个模型族走**两套协议**（官方文档确认，别混用）：
//   qwen-image-*   → OpenAI 兼容：POST {base}/compatible-mode/v1/images/generations
//                    参数**全部平铺在顶层**（没有 input / parameters 嵌套）
//   wan2.7-image*  → DashScope 原生：POST {base}/api/v1/services/aigc/multimodal-generation/generation
//                    { model, input:{messages:[{role,content:[{image},{text}]}]}, parameters:{size,n,watermark} }
//
// 计费：**按张计费**（token 不计费）。所以张数能被精确统计与控制 —— art.mjs generate 的额度闸门靠它。
// 返回的图片 URL 有时效（万相 24h），必须立刻下载。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_BASE = 'https://token-plan.cn-beijing.maas.aliyuncs.com';
/** 默认模型：官方文档确认同时支持文生图与图生图/图像编辑。 */
export const DEFAULT_MODEL = 'qwen-image-3.0-pro';

/**
 * 白名单 —— 只允许这些模型被调用。**故意写死**：这个账号是按张计费的，
 * 不能让 --model 随手写一个就走，避免误调到更贵的模型。
 */
export const QWEN_MODELS = Object.freeze(['qwen-image-3.0-pro', 'qwen-image-3.0', 'qwen-image-2.1-pro', 'qwen-image-2.1-turbo']);
export const WAN_MODELS = Object.freeze(['wan2.7-image', 'wan2.7-image-pro']);
export const ALLOWED_MODELS = Object.freeze([...QWEN_MODELS, ...WAN_MODELS]);

/** 各家支持的参考图张数上限（官方文档）。 */
export const maxRefImages = (model) => (String(model).startsWith('qwen-image-3.0') ? 3 : String(model).startsWith('qwen-image-2.1') ? 10 : 3);
/** 是否支持输出透明通道（qwen-image-2.1 系列）。 */
export const supportsAlpha = (model) => /^qwen-image-2.1/.test(String(model));
export const isQwen = (model) => QWEN_MODELS.includes(model);
export const isWan = (model) => WAN_MODELS.includes(model);

export const modelSupportsRef = (model) => ALLOWED_MODELS.includes(model); // 两族都支持 I2I
export const pickSize = (w, h) => {
  // 输出总像素需在 512²–2048² 之间；这里按目标宽高比挑一个方正的档位
  const ratio = w && h ? w / h : 1;
  const area = 1024 * 1024;
  const rh = Math.round(Math.sqrt(area / ratio) / 16) * 16;
  const rw = Math.round((rh * ratio) / 16) * 16;
  const clamp = (v) => Math.max(512, Math.min(2048, v));
  return clamp(rw) + '*' + clamp(rh);
};

export function resolveKey({ repoRoot, layerDir } = {}) {
  for (const env of ['ALIYUN_API_KEY', 'DASHSCOPE_API_KEY']) {
    if (process.env[env]) return { key: process.env[env].trim(), from: env + ' 环境变量' };
  }
  const cands = [layerDir && path.join(layerDir, '.env'), repoRoot && path.join(repoRoot, '.env')].filter(Boolean);
  for (const abs of cands) {
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const m = /^\s*(?:export\s+)?(ALIYUN_API_KEY|DASHSCOPE_API_KEY)\s*=\s*(.+?)\s*$/.exec(line);
      if (m && m[2]) return { key: m[2].replace(/^["']|["']$/g, ''), from: abs };
    }
  }
  return { key: null, from: null };
}

/** 本地图 → data URI（官方支持 data:{MIME};base64,{data}）。 */
function dataUri(abs) {
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
}

async function postJson(url, key, body, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok || json?.code) {
    const e = new Error(`HTTP ${res.status} ${json?.code ? json.code + ': ' : ''}${json?.message || text.slice(0, 200)}`);
    e.status = res.status; e.code = json?.code;
    e.retryable = res.status === 429 || res.status >= 500;
    e.billed = false; // 文档：只统计成功结果 → 失败不计费
    throw e;
  }
  return json;
}

/** 从两种响应里取出图片 URL 与张数。 */
function extractImage(json) {
  const url = json?.data?.[0]?.url
    ?? json?.output?.choices?.[0]?.message?.content?.find?.((c) => c && c.image)?.image
    ?? null;
  if (!url) throw new Error('返回里没有图片：' + JSON.stringify(json).slice(0, 250));
  const count = json?.usage?.image_count ?? json?.data?.length ?? 1;
  const size = json?.usage?.size ?? json?.data?.[0]?.size ?? null;
  return { url, count, size };
}

/**
 * 组装请求（**不发出去**）。dry-run 用它把「到底会发什么」如实打出来，供人工过目。
 * @param {{ summarize?: boolean }} [o]
 */
export function buildRequest(opts, { summarize = false } = {}) {
  const model = opts.model || DEFAULT_MODEL;
  if (!ALLOWED_MODELS.includes(model)) throw new Error(`模型 ${model} 不在白名单里。允许：${ALLOWED_MODELS.join(' / ')}`);
  const base = (opts.base || process.env.ALIYUN_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  const refs = (Array.isArray(opts.refPaths) ? opts.refPaths : opts.refPaths ? [opts.refPaths] : []).filter(Boolean);
  const cap = maxRefImages(model);
  if (refs.length > cap) throw new Error(`${model} 最多接受 ${cap} 张参考图，收到 ${refs.length}`);
  const img = (p) => (summarize
    ? `data:image/png;base64,<省略 ${(fs.statSync(p).size / 1024).toFixed(0)} KB>`
    : dataUri(p));
  const prompt = opts.negative ? `${opts.prompt}\n避免出现：${opts.negative}` : opts.prompt;

  if (isQwen(model)) {
    const body = {
      model, prompt, n: 1, watermark: opts.watermark === true,
      prompt_extend: opts.promptExtend !== false,
      ...(opts.seed != null ? { seed: opts.seed } : {}),
      ...(opts.size ? { size: opts.size } : {}),
    };
    if (refs.length === 1) body.image = img(refs[0]);
    else if (refs.length > 1) body.image = refs.map(img);
    // prompt_extend_mode=agent 只支持 T2I；有参考图时必须 direct，否则 400
    if (body.prompt_extend) body.prompt_extend_mode = refs.length ? 'direct' : (opts.promptExtendMode || 'direct');
    if (opts.thinking === true && body.prompt_extend) body.enable_thinking = true;
    return { url: base + '/compatible-mode/v1/images/generations', body, refCount: refs.length, protocol: 'openai-compatible' };
  }
  const content = [...refs.map((p) => ({ image: img(p) })), { text: prompt }];
  return {
    url: base + '/api/v1/services/aigc/multimodal-generation/generation',
    body: { model, input: { messages: [{ role: 'user', content }] }, parameters: { size: opts.size || '2K', n: 1, watermark: opts.watermark === true, ...(opts.seed != null ? { seed: opts.seed } : {}) } },
    refCount: refs.length, protocol: 'dashscope-native',
  };
}

/**
 * 生成 / 编辑一张图。**会消耗额度** —— 调用方必须已经拿到用户的明确批准。
 * @param {{ key: string, base?: string, model?: string, prompt: string, negative?: string,
 *           refPaths?: string[]|string, size?: string, seed?: number, watermark?: boolean,
 *           promptExtend?: boolean, thinking?: boolean, timeoutMs?: number }} opts
 */
export async function generateImage(opts) {
  const req = buildRequest(opts);
  const json = await postJson(req.url, opts.key, req.body, opts.timeoutMs ?? 300000);
  return await downloadResult(json);
}

/** 从响应里取图并下载（两种协议共用）。 */
async function downloadResult(json) {
  const got = extractImage(json);
  const imgRes = await fetch(got.url, { signal: AbortSignal.timeout(180000) });
  if (!imgRes.ok) throw new Error('下载生成结果失败：HTTP ' + imgRes.status);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  return {
    b64: buf.toString('base64'),
    mime: imgRes.headers.get('content-type') || 'image/png',
    imageCount: got.count,
    reportedSize: got.size,
    requestId: json?.request_id,
  };
}
