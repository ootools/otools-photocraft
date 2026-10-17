/**
 * 构建插件前端 → dist/。
 * ------------------------------------------------------------------
 * 这个脚本是模板里**唯一的构建入口**，支持两种模式，自动判断：
 *
 *   web 模式（默认，适合「用户开发新插件」）
 *     没有 shell/Cargo.toml 时：直接把 web/ 整个拷贝到 dist/。
 *     你的前端用什么框架都行（原生 JS / Vite / React…），只要把产物放到
 *     web/ 或自己构建后输出到 dist/ 即可。本模式不需要 Rust 工具链。
 *
 *   rust 模式（适合「移植别的 Rust+WASM+egui 软件」）
 *     存在 shell/Cargo.toml 时：按 upstream.pin 拉上游（若提供）→ 按需拉中文字体
 *     （若提供 cjk-fonts.pin）→ 用 trunk 把 shell/ 编译成 WASM 到 dist/。
 *
 * 上游要求 rustc >= 1.95（egui 0.36 的最低要求；如果你的上游更低可以改 MIN_RUSTC_MINOR）。
 *
 * 用法：node scripts/build-web.mjs [--debug]
 *
 * 依赖（仅 rust 模式）：
 *   - trunk           （cargo install trunk，或下载 https://github.com/trunk-rs/trunk/releases 预编译二进制）
 *   - rustc >= 1.95 + wasm32-unknown-unknown 目标
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const debug = process.argv.includes('--debug');
const plugin = JSON.parse(fs.readFileSync(path.join(repoRoot, 'plugin.json'), 'utf8'));
const label = plugin.displayName ?? plugin.packid ?? 'plugin';

// stdin 必须是 'ignore'：某些机器（安全软件挂钩匿名管道）上给子进程接 stdin 管道
// 会让 CreateProcess 直接 EBUSY。
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) {
    console.error(`执行失败：${command} ${args.join(' ')}`);
    console.error(result.error.message);
    process.exit(1);
  }
  return result.status ?? 1;
};

const capture = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  if (result.error) return null;
  return result.stdout?.trim() ?? '';
};

const shellCargo = path.join(repoRoot, 'shell', 'Cargo.toml');
const rustMode = fs.existsSync(shellCargo);

// ----------------------------------------------------------------- web 模式
if (!rustMode) {
  const webDir = path.join(repoRoot, 'web');
  if (!fs.existsSync(webDir)) {
    console.error('web/ 目录不存在，也没有 shell/Cargo.toml。请至少提供其中一种前端来源。');
    process.exit(1);
  }
  const dist = path.join(repoRoot, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  // 清掉旧的再拷，避免 stale 产物混进来（pack 时会校验 entry 指向的是最新文件）。
  for (const name of fs.readdirSync(dist)) {
    fs.rmSync(path.join(dist, name), { recursive: true, force: true });
  }
  fs.cpSync(webDir, dist, { recursive: true });
  const entry = path.join(dist, 'index.html');
  if (!fs.existsSync(entry)) {
    console.error(`web/index.html 不存在，但 plugin.json 的 entry 指向它。`);
    process.exit(1);
  }
  console.log(`web 模式：已拷贝 web/ → ${dist}`);
  for (const name of fs.readdirSync(dist)) {
    const file = path.join(dist, name);
    if (fs.statSync(file).isFile()) console.log(`  ${name} ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
  }
  console.log(`\n完成。${entry} 就绪；用 scripts/deploy-to-otools.ps1 同步到 otools 仓库即可本地试跑。`);
  process.exit(0);
}

// ----------------------------------------------------------------- rust 模式
console.log(`rust 模式：构建 ${label}（${debug ? 'debug' : 'release'}）→ ${path.join(repoRoot, 'dist')}`);

// 上游源码（按需浅拉；缺 upstream.pin 就跳过，直接用 shell/ 里的 crate 编译）。
if (fs.existsSync(path.join(repoRoot, 'upstream.pin'))) {
  if (run('node', [path.join(repoRoot, 'scripts', 'fetch-upstream.mjs')]) !== 0) {
    console.error('上游源码就位失败：见上面的错误。');
    process.exit(1);
  }
} else {
  console.log('未提供 upstream.pin：直接用 shell/ 里的 crate 编译（移植上游软件时放上 upstream.pin）。');
}

// 中文字体（可选）：提供 cjk-fonts.pin 才拉；失败不致命，只是中文 UI 会显示方框。
if (fs.existsSync(path.join(repoRoot, 'cjk-fonts.pin'))) {
  if (run('node', [path.join(repoRoot, 'scripts', 'fetch-cjk-fonts.mjs')]) !== 0) {
    console.warn('cjk-fonts 拉取失败（已忽略）：本次构建不包含中文 UI 字体，浏览器里中文将显示为方框。');
  }
}

// ---------------------------------------------------------------- git 通道
//
// 上游 crate 里若有 git 依赖，这些 URL 写成 https，而某些网络环境下访问 github.com 的
// https 会 502（代理把 CONNECT 拦了），SSH 却是通的。这时候用会话级的 insteadOf 把 https
// 改写到 ssh，只在本次构建的进程里生效，不写用户配置、也不影响 CI（CI 里 https 正常）。
function githubHttpsWorks() {
  const probe = spawnSync('git', ['ls-remote', 'https://github.com/octocat/Hello-World.git', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000,
  });
  return probe.status === 0;
}

const env = { ...process.env, CARGO_NET_GIT_FETCH_WITH_CLI: 'true' };
if (process.env.CI !== 'true' && env.OT_GIT_SSH_REWRITE !== '0' && !githubHttpsWorks()) {
  console.log('▸ github.com 的 https 不通，本次构建把 https://github.com/ 改写到 git@github.com:（仅进程内生效）');
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'url.git@github.com:.insteadOf';
  env.GIT_CONFIG_VALUE_0 = 'https://github.com/';
}
delete env.OT_GIT_SSH_REWRITE;

// trunk 把 NO_COLOR 当成布尔参数读：某些环境（CI 沙箱、TERM=dumb）里它是 '1'，
// trunk 会以 `invalid value '1' for '--no-color'` 直接退出。归一成合法布尔值。
if (env.NO_COLOR && !/^(?:true|false)$/i.test(env.NO_COLOR)) {
  console.log(`\u25b8 NO_COLOR=${env.NO_COLOR} 不是合法布尔值，trunk 会拒绝启动；本次构建改为 'true'。`);
  env.NO_COLOR = 'true';
}

// sccache 会把 cargo 指向 PATH 里的旧 rustc，导致特性/版本不对——直接忽略它。
if (env.RUSTC_WRAPPER) {
  console.log(`▸ 忽略 RUSTC_WRAPPER=${env.RUSTC_WRAPPER}（它会让 cargo 用错工具链）`);
  env.RUSTC_WRAPPER = '';
}

// ---------------------------------------------------------------- 工具链检查

/** 找一个可用的 rustc：优先 rustup 的 default，其次 PATH 里的。 */
function resolveRustc() {
  const rustup = capture('rustup', ['which', 'rustc'], { env });
  if (rustup && fs.existsSync(rustup)) return rustup;
  const which = process.platform === 'win32' ? 'where' : 'which';
  const found = capture(which, ['rustc'], { env });
  const first = found?.split(/\r?\n/)[0];
  return first && fs.existsSync(first) ? first : null;
}

const rustc = resolveRustc();
if (!rustc) {
  console.error('找不到 rustc。请先安装 Rust（>= 1.95）：https://rustup.rs');
  process.exit(1);
}

// 不同上游对 rustc 版本要求不同；默认按 egui 0.36 的 1.95，移植旧上游可调低。
const MIN_RUSTC_MINOR = Number(process.env.MIN_RUSTC_MINOR ?? '95');
const version = capture(rustc, ['--version'], { env }) ?? '';
const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
const [major, minor] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
if (major === 0 || major < 1 || (major === 1 && minor < MIN_RUSTC_MINOR)) {
  console.error(`rustc 版本过低：${version}`);
  console.error(`${label} 需要 rustc >= 1.${MIN_RUSTC_MINOR}（可用 MIN_RUSTC_MINOR 环境变量调整）。升级：rustup update stable && rustup target add wasm32-unknown-unknown`);
  process.exit(1);
}

const targets = capture('rustup', ['target', 'list', '--installed'], { env }) ?? '';
if (targets && !targets.includes('wasm32-unknown-unknown')) {
  console.error('缺少 wasm32-unknown-unknown 目标。安装：rustup target add wasm32-unknown-unknown');
  process.exit(1);
}

const trunk = capture(process.platform === 'win32' ? 'where' : 'which', ['trunk'], { env });
if (!trunk) {
  console.error('找不到 trunk。安装：cargo install trunk（或下载 https://github.com/trunk-rs/trunk/releases 的预编译二进制放入 PATH）');
  process.exit(1);
}

console.log(`rustc: ${version}`);
console.log(`trunk: ${trunk}`);

// 让 trunk/cargo 用和 rustc 同一个 rustup 工具链（PATH 里可能还残留旧的 1.94）。
const cargoPath = capture('rustup', ['which', 'cargo'], { env }) ?? null;
if (!cargoPath || !fs.existsSync(cargoPath)) {
  console.error('找不到 cargo（rustup 应确保可用）。');
  process.exit(1);
}
const cargoDir = path.dirname(cargoPath);
env.PATH = `${cargoDir}${path.delimiter}${env.PATH ?? ''}`;
env.CARGO = cargoPath;
console.log(`cargo: ${cargoPath}`);

// CJK UI 文本：嵌入中文字体（不嵌入则在浏览器里中文显示为方框）。
// 这里默认用 ArtCraft 家族的 CRAFT_FONTS_DIR / FIGCRAFT_EMBED_CJK；如果你的上游用别的
// 环境变量控制字体嵌入，改下面两行即可。
const cjkFontsDir = path.resolve(repoRoot, '..', 'cjk-fonts');
if (fs.existsSync(cjkFontsDir)) {
  env.CRAFT_FONTS_DIR = cjkFontsDir;
  env.FIGCRAFT_EMBED_CJK = '1';
  console.log(`CJK 字体：CRAFT_FONTS_DIR=${cjkFontsDir}（FIGCRAFT_EMBED_CJK=1）`);
} else {
  console.warn('未找到 ../cjk-fonts，跳过中文 UI 字体嵌入（中文将显示为方框）。');
}

const status = run(trunk, ['build', debug ? '' : '--release'].filter(Boolean), {
  cwd: path.join(repoRoot, 'shell'),
  env,
});
if (status !== 0) {
  console.error('trunk 构建失败。');
  process.exit(status);
}

// ----------------------------------------------------------------- 字体就位
// 上游网页版把字体作为站点根下的独立文件分发（启动时 fetch fonts/manifest.txt），
// 本插件照拿：拉到的字体由 prepare-fonts.mjs 选进 dist/fonts/ 并生成 manifest。
if (fs.existsSync(path.join(repoRoot, 'cjk-fonts.pin')) && fs.existsSync(path.join(repoRoot, 'dist'))) {
  run('node', [path.join(repoRoot, 'scripts', 'prepare-fonts.mjs')]);
}

// 插件入口自检：plugin.json 的 entry 必须真的存在
const entry = path.join(repoRoot, 'dist', 'index.html');
if (!fs.existsSync(entry)) {
  console.error(`构建产物里没有 ${entry}，但 plugin.json 的 entry 指向它。`);
  process.exit(1);
}

const size = (file) => `${(fs.statSync(file).size / 1048576).toFixed(1)} MB`;
for (const name of fs.readdirSync(path.join(repoRoot, 'dist'))) {
  const file = path.join(repoRoot, 'dist', name);
  if (fs.statSync(file).isFile()) console.log(`  ${name} ${size(file)}`);
}
console.log(`\n完成。${entry} 就绪；用 scripts/deploy-to-otools.ps1 同步到 otools 仓库即可本地试跑。`);
