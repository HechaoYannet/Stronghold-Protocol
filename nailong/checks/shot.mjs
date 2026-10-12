// nailong/checks/shot.mjs — 起层服务器 → 无头 Chrome 打开某个页面 → 截图。
// 审图/回归都用它：node nailong/checks/shot.mjs /nailong/preview.html out.png [--width 1600] [--height 1000] [--wait 1500] [--full]
import fs from 'node:fs';
import path from 'node:path';
import { startLayer } from '../host/start.mjs';

const [urlPath = '/', outArg = 'shot.png'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes('--' + n);

const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean).find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!CHROME) { console.error('找不到 Chrome/Edge：设 CHROME_PATH'); process.exit(1); }

const srv = await startLayer({ port: 0, host: '127.0.0.1', quiet: true });
const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--mute-audio', '--force-device-scale-factor=1'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: Number(flag('width', 1600)), height: Number(flag('height', 1000)) });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await page.goto(`http://127.0.0.1:${srv.port}${urlPath}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, Number(flag('wait', 1500))));
  const out = path.resolve(outArg);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, fullPage: has('full') });
  const title = await page.title();
  console.log(`✓ ${urlPath} → ${path.relative(process.cwd(), out)}  「${title}」${errors.length ? '  页面异常: ' + errors.slice(0, 2).join(' | ') : ''}`);
} finally {
  await browser.close();
  await srv.close();
}
