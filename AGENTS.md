# AGENTS.md —— otools-photocraft 移植约定

给后续接手这个仓库的 agent（和人）的规则。核心一句话：**`upstream/` 一行都不要改**，
所有移植代码都放在 `shell/`，这样上游同步永远干净。

## 铁律

1. **`upstream/` 保持上游原样**。它是 `storytold/photocraft` 在 `upstream.pin`
   里那个 commit 的浅拉取结果，**不在 git 里**（见 `scripts/fetch-upstream.mjs`）。
   任何「顺手改一下上游」的念头都会在下次同步时丢失或变成冲突。
   **确需裁剪上游时**：改完 `upstream/` 后用 `git diff > shell/patches/<名字>.patch`
   收成补丁、`git checkout -f` 还原，由 `fetch-upstream.mjs` 在每次拉取后幂等重放。
2. `shell/src/web.rs` 是上游 `apps/photocraft-web/src/web.rs` 的整层拷贝，**不要就地改上游逻辑**；
   要改行为就改 `shell/src/otools.rs` 或 `shell/src/main.rs`，或在补丁里改上游。
3. **不引入 native cdylib**。OTools 宿主已经注入了
   `tools_webview_read_file` / `tools_webview_write_file` 与文件对话框，够用；
   再加 FFI 只是多一份动态库要跟着分发。
4. **改 `shell/Cargo.toml` 的上游依赖版本时，对齐 `upstream/Cargo.toml` 的
   `[workspace.dependencies]`**（egui/eframe 目前是 `0.36` 这一档）。

## 上手前必须知道的三件事

- **rustc 版本**：上游 `rust-version = "1.95"`（egui 0.36 用了 1.95 才稳定的
  `Vec::push_mut`）。本机 1.94 会在 `epaint` 上直接 `E0658`。
  本机环境变量 `RUSTC_WRAPPER=sccache` 指向 PATH 里的旧 rustc，会让 cargo 用错工具链
  ——构建前 `unset RUSTC_WRAPPER`（`scripts/build-web.mjs` 也会忽略它）。
- **构建很重**：PhotoCraft 的 crate 图比同家族大一个量级，`wasm-release` 又是 fat LTO，
  首次 release 构建约 20~40 分钟（CI 上类似），之后有 `shell/target/` 缓存。
- **`NO_COLOR` 环境变量**：trunk 把它当布尔参数读，沙箱/CI 里常见的 `NO_COLOR=1`
  会让 trunk 以 `invalid value '1' for '--no-color'` 直接退出。
  `scripts/build-web.mjs` 已归一成合法布尔值。

## 上游管理：pin + 按需拉取（不是 subtree / submodule）

上游源码**不在**本仓库里，只有 `upstream.pin` 记录了仓库与精确的 40 位 commit：

```json
{ "upstream": "storytold/photocraft", "ssh": "…", "https": "…", "ref": "main", "commit": "…" }
```

- **本地/CI 取源码**：`node scripts/fetch-upstream.mjs`（缺失才拉，已对齐就跳过；
  `--force` 丢弃本地改动重拉）。
- **同步上游更新**：改 `upstream.pin` 的 `commit` 为新的完整 SHA，重新拉取，
  然后 diff `upstream/apps/photocraft-web/src/*.rs` 与 `shell/src/*.rs`。
- **为什么不用 subtree**：单个快照几十 MB，且每次同步只增不减，还会把上游几千个文件
  混进自己的树（干扰 grep / IDE 搜索）。pin 到 SHA 反而更可复现。

## 字体：pin + 按需浅拉 + 随站点分发

`cjk-fonts.pin` 记录 `storytold/craft-fonts` 的 commit 与**选用的字体清单**。
`scripts/build-web.mjs` 在 trunk 构建后跑 `scripts/prepare-fonts.mjs`：

1. 字体来源优先 `OT_FONTS_SRC`（本地 craft-fonts 检出），否则 `../cjk-fonts`
   （`scripts/fetch-cjk-fonts.mjs` 拉的兄弟目录，不入库）；
2. 按 pin 的清单拷进 `dist/fonts/…`（路径与 manifest 一致），逐文件校验 sha256；
3. 生成 `dist/fonts/manifest.txt`（上游 `served_fonts` 读的格式）。

缺字体不致命：界面里的中日韩/阿拉伯/泰文显示方框，启动不受影响。

## 移植层的地图

| 文件 | 作用 |
| --- | --- |
| `shell/index.html` | 唯一的 JS：`window.photocraftOtools`（available/theme/language/openFiles/pickSavePath/saveFile） |
| `shell/src/web.rs` | 上游 `apps/photocraft-web/src/web.rs` 整层拷贝 + 两处改动（见下） |
| `shell/src/otools.rs` | 桥：`file_dialog` / `write` / 主题 / 社区链接判定 |
| `shell/src/preset_bridge.rs` | 上游原样副本：IndexedDB 预设库桥 |
| `shell/src/indexed_presets.rs` | 上游原样副本：IndexedDB 读写 |
| `shell/src/download.rs` | 上游浏览器下载回退（原样副本） |
| `shell/src/main.rs` | wasm-only 外壳入口 |
| `shell/patches/*.patch` | 对 `upstream/` 的本地裁剪 |
| `upstream/` | （不在 git 里）上游源码，都是 path 依赖直接复用 |

### 界面语言：首帧跟随宿主（上游网页版在 wasm 下恒英文）

上游 `i18n::system::detect_system_tags()` 在 wasm 下直接返回空向量，因此
`interface.language = auto` 恒解析成英文——浏览器里读不到系统语言偏好。
插件版在 `WebShell::logic` 的首帧把宿主语言（`window.__OTOOLS_LOCALE__.locale`）
写进`interface.language`，见 `crate::otools::follow_host_language`。

**必须在首帧做，不能在构造时做**：`prefs_ui::load` 在首帧
`app.logic` 里读 localStorage 并调用 `load_prefs_json`，构造时写的值会被它覆盖掉
（表现为「设了语言却永远不生效」）。只在偏好还是 `auto` 时生效，
所以用户手动选过的语言不会被动。

验证：`node scripts/probe-host-bridge.mjs` 会断言存储的 `interface.language` 等于假宿主的
locale（每次运行用新的 Chrome profile，避免上一次存的值遮盖回归）。

### `shell/src/web.rs` 相对上游改了两处

1. `services()` 的 `file_dialog` / `write` 在 OTools 里走宿主桥
   （`crate::otools::file_dialog` / `crate::otools::write`），不在 OTools 里才走
   新抽出来的 `browser_file_dialog`（上游 `rfd` 那条路，原样）；
2. `logic()` 里吞掉社区外链；启动时按宿主主题选 `ThemeKind::Pro` / `ProLight`。

## 已知限制

- 上游网页版的设施都没移植：TCP 控制通道、MCP、macOS 菜单、Wayland/XWayland、
  autosave 崩溃恢复（需要平台目录）。
- 「打开文件夹」类命令回答取消（浏览器/wasm 拿不到文件夹句柄，与上游一致）。
- IndexedDB 是 per-origin 的：插件换目录/重装后预设库会丢（与上游网页版同性质）。

## 不要做的事

- 不要把 `upstream/` 提交进 git（它是构建中间件，不是源码）。
- 不要手改 `upstream/` 里的文件：本地裁剪一律走 `shell/patches/*.patch`，
  由 `scripts/fetch-upstream.mjs` 在拉取后重放（手改会在下次同步时静默丢失——
  补丁没打上时构建报的是「上游没有 xx 符号」这种隔层错误）。
- 不要在本仓库跑 `cargo build` 而不管 target：外壳是 wasm-only 的，
  宿主（x86_64）下 `main()` 只会打印一行提示，别把它当编译报错。