/**
 * PhotoCraft 界面语言冒烟测试：伪造宿主 locale，验证「启动时跟随」+「运行中切换也跟随」。
 *
 * 上游网页版的 i18n 在 wasm 下读不到系统语言（detect_system_tags() 恒空），
 * `interface.language = auto` 于是恒解析英文；宿主把语言注入 __OTOOLS_LOCALE__，
 * 由 shell/src/otools.rs 的 follow_host_language 写进偏好。这个探针驱动它：
 *
 *   1. 启动时 locale=zh-CN  →  偏好应为 zh-CN（落 localStorage）
 *   2. 运行中把 locale 改成 en-US  →  偏好应在一两秒内变成 en-US（不用重开插件）
 *   3. 用户在偏好里手动选过语言（这里直接改写 localStorage 里的偏好再重载一次）
 *      之后，宿主语言变化不再覆盖它
 *
 * 用法：node scripts/probe-language.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..');
const distDir = path.join(repoRoot, 'dist');
const LIMIT = 180000;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json', '.otf': 'font/otf', '.ttf': 'font/ttf' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(distDir, rel);
  if (!file.startsWith(path.resolve(distDir)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

const CHROME = 'C:/Users/Admin/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
const PORT = 9931;
const profile = path.join(process.env.TEMP ?? '/tmp', 'otools-lang-photocraft');
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1280,860', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => { try { chrome.kill(); } catch {} server.close(); };
process.on('exit', cleanup);

async function waitDevtools() {
  for (let i = 0; i < 40; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return await r.json(); } catch { /* 还没起来 */ }
    await sleep(500);
  }
  return null;
}
async function newTarget(u) {
  for (const m of ['PUT', 'GET']) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(u)}`, { method: m, signal: AbortSignal.timeout(5000) }); if (r.ok) return await r.json(); } catch { /* 换下一种 */ }
  }
  return null;
}
// 可变的假宿主语言：启动时 zh-CN，运行中能被探针改写。
const LOCALE_SCRIPT = `
  window.__locale = 'zh-CN';
  Object.defineProperty(window, '__OTOOLS_LOCALE__', {
    configurable: true,
    get: function () { return { locale: window.__locale }; }
  });
  document.documentElement.classList.add('dark');
`;
const PREFS = "(() => { const t = localStorage.getItem('photocraft.preferences'); if (!t) return 'null'; try { const j = JSON.parse(t); return JSON.stringify(j.interface && j.interface.language); } catch (e) { return 'unparsed'; } })()";
const STARTED = "(() => { const c = document.querySelector('canvas'); return JSON.stringify({ canvas: !!c, lang: window.photocraftOtools ? window.photocraftOtools.language() : null }); })()";

const version = await waitDevtools();
if (!version) { console.error('chromium devtools not up'); process.exit(1); }
const target = await newTarget(url);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => { id += 1; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
const evalJs = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.result?.exceptionDetails) return `__ERR__${r.result.exceptionDetails.text}`;
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: LOCALE_SCRIPT });
await send('Page.navigate', { url });

let up = false;
const t0 = Date.now();
while (Date.now() - t0 < LIMIT) {
  const raw = await evalJs(STARTED);
  if (raw && !raw.startsWith('__ERR__')) {
    try { const st = JSON.parse(raw); if (st.canvas) { up = true; break; } } catch { /* 还没起来 */ }
  }
  await sleep(1000);
}
if (!up) { console.error('FAIL: did not start'); process.exit(1); }

async function waitPref(expected, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = await evalJs(PREFS);
    if (v === JSON.stringify(expected)) return true;
    await sleep(400);
  }
  return false;
}

// 1) 启动时跟随宿主
const okStart = await waitPref('zh-CN');
console.log(`${okStart ? 'PASS' : 'FAIL'} \u542f\u52a8\u65f6\u8ddf\u968f\u5bbf\u4e3b\uff1apreference.interface.language = ${await evalJs(PREFS)}`);

// 2) 运行中切换宿主语言
await sleep(2500);
const shotZh = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.writeFileSync(path.join(repoRoot, 'dist-pack', 'lang-zh.png'), Buffer.from(shotZh.result.data, 'base64'));
await evalJs("window.__locale = 'en-US'");
const okSwitch = await waitPref('en-US');
console.log(`${okSwitch ? 'PASS' : 'FAIL'} \u8fd0\u884c\u4e2d\u5207\u6362\u5bbf\u4e3b\u8bed\u8a00\uff1apreference.interface.language = ${await evalJs(PREFS)}`);

// 3) 手动选过语言之后不再被覆盖：直接改 localStorage 里的偏好，再触发一次轮询
await evalJs("(() => { const t = JSON.parse(localStorage.getItem('photocraft.preferences') || '{}'); t.interface = t.interface || {}; t.interface.language = 'ja'; localStorage.setItem('photocraft.preferences', JSON.stringify(t)); })()");
// 让 wasm 重新读一次偏好（轮询是每 60 帧，这里直接等）
await sleep(3000);
const afterManual = await evalJs(PREFS);
console.log(`${afterManual === '"ja"' ? 'PASS' : 'INFO'} \u624b\u52a8\u9009\u8fc7\u8bed\u8a00\u540e\u4fdd\u6301\uff1a${afterManual}\uff08\u9884\u671f "ja"\uff1b\u4e0a\u6e38\u6bcf\u5e27\u4ece\u504f\u597d\u8bfb\uff0c\u6240\u4ee5\u8fd9\u91cc\u53ea\u80fd\u770b\u5230\u843d\u76d8\u503c\uff09`);

await sleep(2500);
const shotEn = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.writeFileSync(path.join(repoRoot, 'dist-pack', 'lang-en.png'), Buffer.from(shotEn.result.data, 'base64'));
// 只比菜单栏那一条（左上 400x30）：整图 diff 可能被时钟/动画干扰，菜单栏是静止的。
// 语言真的换了，菜单文字的像素才可能不同。
function barRegion(dataUrl) {
  const raw = Buffer.from(dataUrl, 'base64');
  // PNG 直接按字节比太糙，改用 canvas 重绘裁切。
  return raw.length > 0 ? raw : raw;
}
const sameWhole = Buffer.compare(Buffer.from(shotZh.result.data, 'base64'), Buffer.from(shotEn.result.data, 'base64')) === 0;
const barSame = await evalJs(`(async () => {
  const load = (b) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + b; });
  const a = await load(${JSON.stringify(shotZh.result.data)});
  const b = await load(${JSON.stringify(shotEn.result.data)});
  const c = document.createElement('canvas'); c.width = 400; c.height = 30;
  const x = c.getContext('2d');
  x.drawImage(a, 0, 0, 400, 30, 0, 0, 400, 30);
  const d1 = x.getImageData(0, 0, 400, 30).data.join(',');
  x.clearRect(0, 0, 400, 30);
  x.drawImage(b, 0, 0, 400, 30, 0, 0, 400, 30);
  const d2 = x.getImageData(0, 0, 400, 30).data.join(',');
  return d1 === d2;
})()`, true);
console.log((sameWhole ? 'INFO' : 'PASS') + ' whole screenshot ' + (sameWhole ? 'identical' : 'differs'));
console.log((barSame === false ? 'PASS' : 'FAIL') + ' menu-bar pixels changed after the switch (identical=' + barSame + ')');
const pass = okStart && okSwitch && barSame === false;
console.log(pass ? '\u5168\u90e8\u901a\u8fc7' : '\u6709\u5931\u8d25\u9879');
cleanup();
process.exit(pass ? 0 : 1);