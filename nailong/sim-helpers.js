// nailong/sim-helpers.js — 服务端引擎助手再导出（自定义干员 kit 的同构入口）。
// 浏览器侧的同名模块在 nailong/web/sim-helpers.js（走 /sim/ URL）。
// 自定义 kit 一律写 `import { … } from '../../sim-helpers.js'`，两边都能解析。
export * from '../server/sim/content/kits/shared/tier1.js';
