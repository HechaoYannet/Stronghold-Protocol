// nailong/build/comfyui.mjs — 本地 ComfyUI 客户端（REST）。
//
// 本机已装 ComfyUI Desktop 1.1.1（内核 v0.37.1）并常驻 127.0.0.1:8188，
// 模型是 Qwen-Image 2.1 的 int8 三件套。**本地推理，不产生任何 API 费用。**
//
// 工作流用官方模板「Image Edit (Qwen Image 2.1)」里那套已验证的节点组合，见 comfyworkflow.mjs。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_BASE = process.env.COMFYUI_URL || 'http://127.0.0.1:8188';
export const CLIENT_ID = randomUUID();

const base = (b) => (b || DEFAULT_BASE).replace(/\/+$/, '');

async function jfetch(url, opts = {}, timeoutMs = 30000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status} ${json?.error?.message || json?.error || text.slice(0, 300)}`);
    e.status = res.status; e.body = json ?? text;
    throw e;
  }
  return json ?? text;
}

/** 探活 + 版本/显存信息。 */
export async function systemStats(opts = {}) {
  return await jfetch(base(opts.base) + '/system_stats', {}, 15000);
}

/** 确认模型文件确实在 ComfyUI 的搜索路径里。 */
export async function objectInfo(opts = {}) {
  return await jfetch(base(opts.base) + '/object_info', {}, 60000);
}

/** 把本地图片传进 ComfyUI 的 input 目录，返回可用于 LoadImage 的文件名。 */
export async function uploadImage(absPath, { base: b, subfolder = 'nailong', overwrite = true } = {}) {
  const buf = fs.readFileSync(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  const fd = new FormData();
  fd.append('image', new Blob([buf], { type: mime }), path.basename(absPath));
  fd.append('overwrite', String(overwrite));
  if (subfolder) fd.append('subfolder', subfolder);
  const r = await jfetch(base(b) + '/upload/image', { method: 'POST', body: fd }, 120000);
  return { name: r.name, subfolder: r.subfolder ?? subfolder, type: r.type ?? 'input', ref: subfolder ? subfolder + '/' + r.name : r.name };
}

/** 提交工作流，返回 prompt_id。 */
export async function queuePrompt(workflow, { base: b, clientId = CLIENT_ID } = {}) {
  const r = await jfetch(base(b) + '/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  }, 60000);
  if (r.node_errors && Object.keys(r.node_errors).length) {
    throw new Error('工作流校验失败：' + JSON.stringify(r.node_errors).slice(0, 900));
  }
  return r.prompt_id;
}

/** 轮询历史直到出结果。本地推理没有网络开销，纯粹等 GPU。 */
export async function waitFor(promptId, { base: b, timeoutMs = 900000, pollMs = 1500, onTick = null } = {}) {
  const t0 = Date.now();
  for (;;) {
    const h = await jfetch(base(b) + '/history/' + promptId, {}, 20000);
    const entry = h?.[promptId];
    if (entry) {
      if (entry.status?.status_str === 'error' || entry.status?.completed === false) {
        const msgs = (entry.status?.messages ?? []).flat().filter((x) => typeof x === 'string');
        throw new Error('执行失败：' + JSON.stringify(entry.status).slice(0, 900));
      }
      if (entry.outputs && Object.keys(entry.outputs).length) {
        return { entry, elapsedMs: Date.now() - t0 };
      }
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时（${Math.round(timeoutMs / 1000)}s），prompt_id=${promptId}`);
    if (onTick) onTick(Date.now() - t0);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** 从 history 结果里取出产物图片并写到本地。 */
export async function fetchOutputs(entry, outPaths, { base: b } = {}) {
  const written = [];
  for (const nodeOut of Object.values(entry.outputs ?? {})) {
    for (const img of nodeOut.images ?? []) {
      const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' });
      const res = await fetch(base(b) + '/view?' + q, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error('取图失败 HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const dest = outPaths.shift();
      if (dest) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf); }
      written.push({ filename: img.filename, bytes: buf.length, dest: dest ?? null });
    }
  }
  return written;
}

/** 一次完整的「传图 → 提交 → 等 → 取图」。 */
export async function runWorkflow(workflow, { outPaths = [], base: b, onTick = null, timeoutMs } = {}) {
  const id = await queuePrompt(workflow, { base: b });
  const { entry, elapsedMs } = await waitFor(id, { base: b, onTick, timeoutMs });
  const files = await fetchOutputs(entry, outPaths, { base: b });
  return { promptId: id, elapsedMs, files };
}
