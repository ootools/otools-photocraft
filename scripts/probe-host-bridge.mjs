/**
 * PhotoCraft 插件的宿主桥冒烟测试：本地静态服务 + 无头 Chromium + 假宿主。
 *
 * 判定四件事：
 *   1. 应用真的启动（loading 节点被 remove、canvas 有尺寸）；
 *   2. 宿主桥可用（注入 window.otools 后 photocraftOtools.available() 为 true）；
 *   3. wasm 真的向宿主要过界面语言（__OTOOLS_LOCALE__.locale 的读取计数）；
 *   4. 文件通路的形状对：openFiles 走宿主对话框、saveFile 经 writeHostFile 落盘、
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
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png',
  '.otf': 'font/otf', '.ttf': 'font/ttf',
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
console.log(`dist -> ${url}`);

const CHROME = 'C:/Users/Admin/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
const DEBUG_PORT = 9800 + (Number(process.pid) % 150);
const profile = path.join(process.env.TEMP ?? '/tmp', `otools-probe-photocraft-${Date.now()}`);

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
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return null;
}

async function newTarget(targetUrl) {
  for (const method of ['PUT', 'GET']) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(targetUrl)}`, { method, signal: AbortSignal.timeout(5000) });
      if (r.ok) return await r.json();
    } catch { /* try the next */ }
  }
  return null;
}

/**
 * 计数陷阱：把 __OTOOLS_LOCALE__.locale 做成 getter 数它被读了几次。
 * 页面内联脚本读一次（设 documentElement.lang），wasm 的 language() 也会读一次，
 * 所以「启动完成时」的读数 > 1 才说明 wasm 真的向宿主要过界面语言。
 */
const TRAP = `(() => {
  let reads = 0;
  Object.defineProperty(window, '__OTOOLS_LOCALE__', {
    configurable: true,
    get: function () {
      return { get locale() { reads += 1; return 'zh-CN'; } };
    },
  });
  Object.defineProperty(window, '__localeReads', { configurable: true, get: function () { return reads; } });
})()`;

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
  // 主题类名等 DOM 就绢后再加（document-start 时 documentElement 还不存在）。
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.classList.add('dark');
  // 实验：预先种下偏好，看整条链路（load_prefs_json + sync_context）能不能走通。
  try {
  } catch (e) { /* ignore */ }
})()`;

/** 只等「启动完成」，不调用 language()——否则探针自己的读取会污染计数。 */
const WAIT = `(() => {
  const loading = document.getElementById('photocraft_loading');
  const canvas = document.getElementById('photocraft_canvas');
  return JSON.stringify({
    loadingGone: loading === null,
    loadingText: loading ? (loading.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : null,
    canvasSize: canvas ? [canvas.width, canvas.height] : null,
  });
})()`;

const CHECK = `(() => {
  const loading = document.getElementById('photocraft_loading');
  const canvas = document.getElementById('photocraft_canvas');
  return JSON.stringify({
    loadingGone: loading === null,
    loadingText: loading ? (loading.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : null,
    canvasSize: canvas ? [canvas.width, canvas.height] : null,
    available: typeof window.photocraftOtools !== 'undefined' && window.photocraftOtools !== null && window.photocraftOtools.available(),
    language: typeof window.photocraftOtools !== 'undefined' && window.photocraftOtools !== null ? window.photocraftOtools.language() : null,
    htmlLang: document.documentElement ? document.documentElement.lang : null,
  });
})()`;

/** 走一遍桥：打开（对话框 -> 读盘）、只选路径、保存（写盘）、覆盖。 */
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
  if (!version) { console.error('cannot start chromium devtools'); process.exit(1); }
  console.log(`  browser: ${version.Browser}`);
  const target = await newTarget(url);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('WebSocket failed')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => { id += 1; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
  const evalJs = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.result?.exceptionDetails) {
      const d = r.result.exceptionDetails;
      return `__ERR__${d.text} ${d.exception?.description ?? d.exception?.value ?? ''}`;
    }
    return r.result?.result?.value;
  };
  const logs = [];
  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(String(event.data));
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params) {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        logs.push(`[${msg.params.type}] ${text}`);
      }
    } catch { /* 忽略 */ }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: TRAP });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK_HOST });
  await send('Page.navigate', { url });

  const started = Date.now();
  let verdict = null;
  while (Date.now() - started < LIMIT) {
    const raw = await evalJs(WAIT);
    if (typeof raw === 'string' && raw.startsWith('__ERR__')) {
      console.error(`page expression failed: ${raw}`);
      process.exit(1);
    }
    const state = raw ? JSON.parse(raw) : null;
    if (state && state.loadingGone && state.canvasSize && state.canvasSize[0] > 0) { verdict = state; break; }
    await sleep(1000);
  }
  if (!verdict) {
    const raw = await evalJs(WAIT);
    console.error(`startup failed: ${raw}`);
    process.exit(1);
  }

  // 启动完成（此刻还没调用过 language()）：页面内联脚本读 1 次，wasm 若读了就 +1。
  const readsAtStartup = Number(await evalJs('window.__localeReads'));
  console.log(`OK startup: canvas=${JSON.stringify(verdict.canvasSize)} (loading ${verdict.loadingText ? 'text: ' + verdict.loadingText : 'gone'})`);
  console.log(`  __OTOOLS_LOCALE__.locale reads at startup: ${readsAtStartup} (1 = page inline script only)`);
  if (readsAtStartup <= 1) {
    console.error('FAIL: wasm never read the host locale -> UI stays English (follow_host_language did not take effect)');
    process.exit(1);
  }

  const stored = await evalJs("(() => { const t = localStorage.getItem('photocraft.preferences'); if (!t) return 'null'; try { const j = JSON.parse(t); return 'language=' + JSON.stringify(j.interface && j.interface.language) + ' theme=' + JSON.stringify(j.interface && j.interface.theme); } catch (e) { return 'unparsed(' + t.length + ')'; } })()");
  console.log(`  stored prefs: ${stored}`);
  if (!String(stored).includes('language="zh-CN"')) {
    console.error(`FAIL: 界面语言没有跟随宿主（存储的是 ${stored}，应为 zh-CN）`);
    process.exit(1);
  }
  const full = await evalJs(CHECK);
  if (typeof full === 'string' && full.startsWith('__ERR__')) {
    console.error(`page expression failed: ${full}`);
    process.exit(1);
  }
  const state = JSON.parse(full);
  console.log(`  bridge: available=${state.available} language=${state.language} htmlLang=${state.htmlLang}`);

  const bridgeRaw = await evalJs(BRIDGE, true);
  if (typeof bridgeRaw !== 'string' || bridgeRaw.startsWith('__ERR__')) {
    console.error(`bridge run failed: ${bridgeRaw}`);
    process.exit(1);
  }
  const bridge = JSON.parse(bridgeRaw);
  const problems = [];
  if (bridge.openedCount !== 1) problems.push(`openFiles returned ${bridge.openedCount} files`);
  if (bridge.openedName !== 'demo.psd') problems.push(`opened name is ${bridge.openedName}`);
  if (bridge.openedBytes !== 'PSD\x01') problems.push(`opened bytes wrong: ${bridge.openedBytes}`);
  if (!bridge.pickedPath) problems.push('pickSavePath returned no path');
  if (!bridge.savedPath) problems.push('saveFile returned no path');
  if (bridge.overwritePath !== bridge.savedPath) problems.push(`second save did not overwrite: ${bridge.overwritePath}`);
  if (!bridge.lastWrite || bridge.lastWrite.bytes !== 'UFNEAQ==') problems.push('writeHostFile did not receive base64');
  if (bridge.diag.bridge !== 'wrapper' && bridge.diag.bridge !== 'raw') problems.push(`bridge channel abnormal: ${bridge.diag.bridge}`);
  if (problems.length) { console.error(`FAIL bridge: ${problems.join('; ')}`); process.exit(1); }
  console.log(`OK bridge: open ${bridge.openedName} -> pick ${bridge.pickedPath} -> save ${bridge.savedPath} -> overwrite ${bridge.overwritePath} (channel ${bridge.diag.bridge})`);

  const interesting = logs.filter((l) => /error|warn|catalog|translat|i18n|lang/i.test(l));
  console.log(`  console (${logs.length} lines, ${interesting.length} interesting):`);
  for (const l of interesting.slice(0, 25)) console.log(`    ${l}`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(repoRoot, 'dist-pack', 'probe-screenshot.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(`OK screenshot ${out}`);
  server.close();
  chrome.kill();
  process.exit(0);
} catch (e) {
  console.error(`FAIL ${e.message}`);
  server.close();
  chrome.kill();
  process.exit(1);
}
