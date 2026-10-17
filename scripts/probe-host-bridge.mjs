/**
 * PhotoCraft 插件的宿主桥冒烟测试：本地静态服务 + 无头 Chromium + 假宿主。
 *
 * 判定三件事：
 *   1. 应用真的启动（loading 节点被 remove、canvas 有尺寸）；
 *   2. 宿主桥可用（注入 window.otools 后 photocraftOtools.available() 为 true）；
 *   3. 文件通路的形状对：openFiles 走宿主对话框、saveFile 经 writeHostFile 落盘，
 *      pickSavePath 只选路径不写文件，且 base64 能解回原始字节。
 *
 * 用法：node scripts/probe-host-bridge.mjs [秒数上限]
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..');
const distDir = path.join(repoRoot, 'dist');
const LIMIT = Number(process.argv[2] ?? 180) * 1000;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.otf': 'font/otf', '.ttf': 'font/ttf',
};
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(distDir, rel);
  if (!file.startsWith(path.resolve(distDir)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/index.html`;
console.log(`\u25b8 dist \u2192 ${url}`);

const CHROME = 'C:/Users/Admin/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
const DEBUG_PORT = 9800 + (Number(process.pid) % 150);
const profile = path.join(process.env.TEMP ?? '/tmp', 'otools-probe-photocraft');

const chrome = spawn(CHROME, [
  '--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return await r.json();
    } catch { /* \u8fd8\u6ca1\u8d77\u6765 */ }
    await sleep(500);
  }
  return null;
}

async function newTarget(targetUrl) {
  for (const method of ['PUT', 'GET']) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(targetUrl)}`, { method, signal: AbortSignal.timeout(5000) });
      if (r.ok) return await r.json();
    } catch { /* \u6362\u4e0b\u4e00\u79cd */ }
  }
  return null;
}

/** 假宿主：形状与 OTools 注入的 window.otools 一致（含 Tauri IPC 直连那条路）。 */
const MOCK_HOST = `(() => {
  const files = { 'C:\\\\pic\\\\demo.psd': 'UFNEAQ==' };
  window.otools = {
    dialog: {
      open: async () => ['C:\\\\pic\\\\demo.psd'],
      save: async (o) => String((o && o.defaultPath) || 'C:\\\\pic\\\\out.psd'),
    },
    readHostFile: async (p) => ({ path: p, name: p.split('\\\\').pop(), dataBase64: files[p] || '' }),
    writeHostFile: async (r) => { window.__lastWrite = r; return { path: r.path }; },
  };
  window.__TAURI_INTERNALS__ = { invoke: async (cmd, args) => {
    if (cmd === 'tools_webview_write_file') { window.__lastWrite = args && args.request; return { path: args.request.path }; }
    if (cmd === 'tools_webview_read_file') { const p = args.path; return { path: p, name: p.split('\\\\').pop(), dataBase64: files[p] || '' }; }
    if (cmd === 'tools_webview_pick_files') return ['C:\\\\pic\\\\demo.psd'];
    if (cmd === 'tools_webview_pick_save_path') return { path: (args.options && args.options.suggestedName) || 'out.psd' };
    throw new Error('unexpected command ' + cmd);
  } };
  window.__OTOOLS_LOCALE__ = { locale: 'zh-CN' };
  document.documentElement.classList.add('dark');
})()`;

const CHECK = `(() => {
  const loading = document.getElementById('photocraft_loading');
  const canvas = document.getElementById('photocraft_canvas');
  return JSON.stringify({
    loadingGone: loading === null,
    loadingText: loading ? (loading.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : null,
    canvasSize: canvas ? [canvas.width, canvas.height] : null,
    available: typeof window.photocraftOtools !== 'undefined' && window.photocraftOtools.available(),
    language: typeof window.photocraftOtools !== 'undefined' ? window.photocraftOtools.language() : null,
  });
})()`;

/** 走一遍桥：打开（对话框 → 读盘）、只选路径、保存（写盘）、覆盖。 */
const BRIDGE = `(async () => {
  const b = window.photocraftOtools;
  const opened = await b.openFiles({ title: 'x', filters: [{ name: 'Supported', extensions: ['psd'] }], multiple: true });
  const picked = await b.pickSavePath({ name: 'Shot.psd' });
  const saved = await b.saveFile({ name: 'Shot.psd', dataBase64: 'UFNEAQ==', forcePick: true });
  const again = await b.saveFile({ name: 'Shot.psd', dataBase64: 'UFNEAQ==' });
  return JSON.stringify({
    openedCount: opened.length,
    openedName: opened[0] && opened[0].name,
    openedBytes: opened[0] && atob(opened[0].dataBase64),
    pickedPath: picked && picked.path,
    savedPath: saved && saved.path,
    overwritePath: again && again.path,
    lastWrite: window.__lastWrite ? { path: window.__lastWrite.path, bytes: window.__lastWrite.dataBase64 } : null,
    diag: JSON.parse(window.localStorage.getItem('photocraft.otools.diag') || '{}'),
  });
})()`;

try {
  const version = await waitForDevtools();
  if (!version) { console.error('\u2717 \u8d77\u4e0d\u6765 chromium \u7684 devtools'); process.exit(1); }
  console.log(`  browser: ${version.Browser}`);
  const target = await newTarget(url);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('WebSocket \u8fde\u63a5\u5931\u8d25')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => { id += 1; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
  const evalJs = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.result?.exceptionDetails) return `__ERR__${r.result.exceptionDetails.text}`;
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  // 假宿主必须在页面任何脚本之前就位（wasm 启动时就要读到 window.otools）。
  await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK_HOST });
  await send('Page.navigate', { url });

  const started = Date.now();
  let verdict = null;
  while (Date.now() - started < LIMIT) {
    const raw = await evalJs(CHECK);
    const state = raw ? JSON.parse(raw) : null;
    if (state && state.loadingGone && state.canvasSize && state.canvasSize[0] > 0) { verdict = state; break; }
    await sleep(1000);
  }
  if (!verdict) {
    const raw = await evalJs(CHECK);
    console.error(`\u2717 \u542f\u52a8\u5931\u8d25\uff1a${raw}`);
    process.exit(1);
  }
  console.log(`\u2713 \u542f\u52a8\u6210\u529f\uff1acanvas=${JSON.stringify(verdict.canvasSize)} available=${verdict.available} language=${verdict.language}`);
  if (verdict.loadingText) console.log(`  loading \u6587\u672c\uff1a${verdict.loadingText}`);

  const bridgeRaw = await evalJs(BRIDGE, true);
  if (typeof bridgeRaw !== 'string' || bridgeRaw.startsWith('__ERR__')) {
    console.error(`\u2717 \u6865\u8fd0\u884c\u5931\u8d25\uff1a${bridgeRaw}`);
    process.exit(1);
  }
  const bridge = JSON.parse(bridgeRaw);
  const problems = [];
  if (bridge.openedCount !== 1) problems.push(`openFiles \u8fd4\u56de ${bridge.openedCount} \u4e2a\u6587\u4ef6`);
  if (bridge.openedName !== 'demo.psd') problems.push(`\u6253\u5f00\u7684\u540d\u5b57\u662f ${bridge.openedName}`);
  if (bridge.openedBytes !== 'PSD\x01') problems.push(`\u8bfb\u5230\u7684\u5b57\u8282\u9519\u8bef\uff1a${bridge.openedBytes}`);
  if (!bridge.pickedPath) problems.push('pickSavePath \u6ca1\u8fd4\u56de\u8def\u5f84');
  if (!bridge.savedPath) problems.push('saveFile \u6ca1\u8fd4\u56de\u8def\u5f84');
  if (bridge.overwritePath !== bridge.savedPath) problems.push(`\u7b2c\u4e8c\u6b21\u4fdd\u5b58\u6ca1\u8d70\u8986\u76d6\uff1a${bridge.overwritePath}`);
  if (!bridge.lastWrite || bridge.lastWrite.bytes !== 'UFNEAQ==') problems.push('writeHostFile \u6ca1\u6536\u5230 base64');
  if (bridge.diag.bridge !== 'wrapper' && bridge.diag.bridge !== 'raw') problems.push(`\u6865\u901a\u9053\u5f02\u5e38\uff1a${bridge.diag.bridge}`);
  if (problems.length) { console.error(`\u2717 \u6865\u95ee\u9898\uff1a${problems.join('\uff1b')}`); process.exit(1); }
  console.log(`\u2713 \u6865\u901a\u4e86\uff1a\u6253\u5f00 ${bridge.openedName}\uff08${bridge.openedBytes}\uff09\u2192 \u9009\u8def\u5f84 ${bridge.pickedPath} \u2192 \u4fdd\u5b58 ${bridge.savedPath} \u2192 \u8986\u76d6 ${bridge.overwritePath}\uff08\u901a\u9053 ${bridge.diag.bridge}\uff09`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(repoRoot, 'dist-pack', 'probe-screenshot.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(`\u2713 \u622a\u56fe ${out}`);
  server.close();
  chrome.kill();
  process.exit(0);
} catch (e) {
  console.error(`\u2717 ${e.message}`);
  server.close();
  chrome.kill();
  process.exit(1);
}