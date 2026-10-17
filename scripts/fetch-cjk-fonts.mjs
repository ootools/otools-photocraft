/**
 * 按需拉取中文字体仓库到 ../cjk-fonts（**不入库**，是插件仓库的兄弟目录）。
 *
 * 为什么需要它：绝大多数 Rust+WASM 的 UI 库（egui 等）默认只带拉丁字形，
 * 不嵌中文字体会让浏览器里的中文 UI 显示为方框。把整套 CJK 字体（Noto Sans CJK
 * 等，往往 10~30MB）直接塞进插件仓库既臃肿又不必要——所以作为兄弟目录按需浅拉，
 * pin 到精确 SHA 保证可复现。
 *
 * 字体仓库的格式约定（与 ArtCraft 家族一致）：根下有 `fonts/manifest.txt`，
 * 构建脚本（如 build-web.mjs）把 `CRAFT_FONTS_DIR` 指向这里、`FIGCRAFT_EMBED_CJK=1`
 * 开启嵌入。如果你的上游用别的目录/变量，改 build-web.mjs 里对应两行即可。
 *
 * 用法：
 *   node scripts/fetch-cjk-fonts.mjs            # 缺失才拉，已在 pinned commit 就跳过
 *   node scripts/fetch-cjk-fonts.mjs --force    # 丢弃本地改动，强制回到 pinned commit
 *   node scripts/fetch-cjk-fonts.mjs --check    # 只检查是否已对齐（不拉取）
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const force = argv.includes('--force');
const checkOnly = argv.includes('--check');
const pinPath = path.join(repoRoot, 'cjk-fonts.pin');
// 兄弟目录：与插件仓库同级（不进本仓库）。
const fontsDir = path.resolve(repoRoot, '..', 'cjk-fonts');

if (!fs.existsSync(pinPath)) {
  console.error('缺少 cjk-fonts.pin（应含 ssh/https/commit 字段）。不需要中文 UI 可忽略本脚本。');
  process.exit(1);
}
const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
if (!/^[0-9a-f]{40}$/.test(pin.commit ?? '')) {
  console.error('cjk-fonts.pin 的 commit 必须是 40 位完整 SHA');
  process.exit(1);
}

// GIT_TERMINAL_PROMPT=0：CI 里取不到凭证时立刻失败，不要卡在交互输入上。
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
const exec = (args, cwd) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });

const shortSha = pin.commit.slice(0, 12);

function currentHead() {
  if (!fs.existsSync(path.join(fontsDir, '.git'))) return null;
  const r = exec(['rev-parse', 'HEAD'], fontsDir);
  return r.status === 0 ? r.stdout.trim() : null;
}

// 已是 pinned commit：直接跳过（省一次几十 MB 的下载 + 字体校验）。
if (!force && fs.existsSync(path.join(fontsDir, '.git'))) {
  const head = currentHead();
  if (head === pin.commit) {
    const dirty = exec(['status', '--porcelain'], fontsDir).stdout.trim();
    if (!dirty) {
      console.log(`cjk-fonts 已是 ${pin.upstream}@${shortSha}，跳过拉取。`);
      process.exit(0);
    }
    console.log('cjk-fonts 有本地改动，重新拉取对齐 pinned commit。');
  }
}

if (checkOnly) {
  const head = currentHead();
  if (head === pin.commit) {
    console.log(`已对齐 ${shortSha}`);
    process.exit(0);
  }
  console.error(`未对齐：期望 ${pin.commit}，实际 ${head ?? '（字体目录不存在）'}`);
  process.exit(1);
}

const transports = [
  ['ssh', pin.ssh],
  ['https', pin.https],
].filter(([, url]) => Boolean(url));

for (const [label, url] of transports) {
  console.log(`▸ 从 ${label} 拉取 cjk-fonts@${shortSha} …`);
  fs.mkdirSync(fontsDir, { recursive: true });
  if (!fs.existsSync(path.join(fontsDir, '.git'))) {
    const init = exec(['init', '-q'], fontsDir);
    if (init.status !== 0) {
      console.error(`  git init 失败：${init.stderr?.trim()}`);
      continue;
    }
  }
  exec(['remote', 'remove', 'origin'], fontsDir);
  const added = exec(['remote', 'add', 'origin', url], fontsDir);
  if (added.status !== 0) {
    console.error(`  git remote add 失败：${added.stderr?.trim()}`);
    continue;
  }
  let fetched = false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const r = exec(['fetch', '--depth', '1', 'origin', pin.commit], fontsDir);
    if (r.status === 0) {
      fetched = true;
      break;
    }
    const reason = `${r.stderr || r.stdout || ''}`.trim().split('\n')[0];
    console.error(`  第 ${attempt} 次失败：${reason}`);
  }
  if (!fetched) continue;
  const checkout = exec(['checkout', '-f', '--detach', 'FETCH_HEAD'], fontsDir);
  if (checkout.status !== 0) {
    console.error(`  检出失败：${checkout.stderr?.trim()}`);
    continue;
  }
  const got = currentHead();
  if (got !== pin.commit) {
    console.error(`  SHA 不符：期望 ${pin.commit}，实际 ${got}`);
    continue;
  }
  // 字体清单必须存在，否则构建时中文会缺字体。
  const manifest = path.join(fontsDir, 'fonts', 'manifest.txt');
  if (!fs.existsSync(manifest)) {
    console.error('  拉取成功但 fonts/manifest.txt 不存在，字体目录可能不完整。');
    continue;
  }
  console.log(`✓ 成功（${label}）：${pin.upstream}@${shortSha} → ${fontsDir}`);
  process.exit(0);
}

console.error('cjk-fonts 全部通道失败：SSH 需要本机配好 GitHub key，HTTPS 需要能直连 github.com。');
process.exit(1);
