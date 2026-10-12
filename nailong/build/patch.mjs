// nailong/build/patch.mjs — 声明式数据补丁引擎（作用于 data/*.json）。
//
// 补丁文件（nailong/data-patches/*.json）：
//   { "patches": [ { "file": "config.json", "note": "…", "ops": [ {op, path, value} … ] } ] }
//
// op：
//   set     在 path 写入 value（父级不存在则按需创建对象）
//   merge   把 value（对象）深合并到 path 上
//   push    把 value 追加到 path 数组末尾
//   delete  删除 path
//
// path 用点号分隔；纯数字段表示数组下标。空 path（""）表示整个文件根。
// 找不到父级（例如把键写错）时记一条 problem，而不是静默创建一个垃圾分支。

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 'a.b.0.c' → ['a','b','0','c']（数字段保持字符串，取值时两种键都能命中数组）。 */
export const pathSegments = (p) => String(p ?? '').split('.').map((s) => s.trim()).filter((s) => s.length > 0);

function getIn(doc, segs) {
  let cur = doc;
  for (const k of segs) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 写入并返回是否成功；父级缺失时返回 false。 */
function setIn(doc, segs, value) {
  if (!segs.length) return false;
  let cur = doc;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    if (cur == null || typeof cur !== 'object') return false;
    let next = cur[k];
    if (next == null) {
      // 只在父级是对象/数组时才补一个容器，避免把错键写成新分支
      next = /^\d+$/.test(segs[i + 1]) && Array.isArray(cur) ? [] : {};
      cur[k] = next;
    }
    if (typeof next !== 'object') return false;
    cur = next;
  }
  cur[segs[segs.length - 1]] = value;
  return true;
}

function mergeInto(dst, src) {
  for (const [k, v] of Object.entries(src ?? {})) {
    if (isObj(v) && isObj(dst[k])) mergeInto(dst[k], v);
    else dst[k] = v;
  }
  return dst;
}

/**
 * 对一个已解析的 JSON 文档应用补丁。
 * @param {any} doc 已深拷贝、可自由修改的文档
 * @param {{op: string, path?: string, value?: any}[]} ops
 * @param {{ file?: string }} [ctx] 只用于 problem 文案
 * @returns {{ applied: number, problems: string[] }}
 */
export function applyOps(doc, ops, ctx = {}) {
  const problems = [];
  let applied = 0;
  for (const [i, op] of (ops ?? []).entries()) {
    const where = `${ctx.file ?? '?'} op#${i} ${op?.op ?? '?'} "${op?.path ?? ''}"`;
    if (!isObj(op) || typeof op.op !== 'string') { problems.push(`${where}: not an {op, path, value} object`); continue; }
    const segs = pathSegments(op.path);
    switch (op.op) {
      case 'set':
        if (!segs.length) { problems.push(`${where}: "set" needs a path`); break; }
        if (setIn(doc, segs, op.value)) applied++;
        else problems.push(`${where}: parent not found`);
        break;
      case 'merge': {
        if (!segs.length) { problems.push(`${where}: "merge" needs a path`); break; }
        const cur = getIn(doc, segs);
        if (isObj(cur) && isObj(op.value)) { mergeInto(cur, op.value); applied++; }
        else problems.push(`${where}: target is not an object`);
        break;
      }
      case 'push': {
        const cur = getIn(doc, segs);
        if (Array.isArray(cur)) { cur.push(op.value); applied++; }
        else problems.push(`${where}: target is not an array`);
        break;
      }
      case 'delete': {
        if (!segs.length) { problems.push(`${where}: "delete" needs a path`); break; }
        const parent = getIn(doc, segs.slice(0, -1));
        const last = segs[segs.length - 1];
        if (parent == null || typeof parent !== 'object' || !(last in parent)) { problems.push(`${where}: not found`); break; }
        delete parent[last];
        applied++;
        break;
      }
      default:
        problems.push(`${where}: unknown op "${op.op}" (set | merge | push | delete)`);
    }
  }
  return { applied, problems };
}
