# PhotoCraft · OTools 插件

[PhotoCraft](https://github.com/storytold/photocraft) 是 storytold 的 ArtCraft「Crafting Apps」家族之一：
纯 Rust 重写的 Photoshop 式图像编辑器，编译为 WebAssembly + egui，在浏览器里运行。
本仓库把它移植成 OTools 插件：UI 仍是上游 `photocraft-ui-egui`，只替换了「文件从哪来、存到哪去」。

> 同家族移植模式见 `../otools-vectorcraft`（矢量绘图）。本插件沿用同一套结构。

## 目录结构

```
otools-photocraft/
├── plugin.json            # 插件清单（宿主只认这个 + logo + dist）
├── logo.svg               # 插件图标
├── upstream.pin           # 上游 commit SHA（按需浅拉，不入库）
├── cjk-fonts.pin          # 字体仓库 commit SHA + 选用字体清单（按需浅拉，不入库）
├── upstream/              # 上游源码（git 浅拉，.gitignore 忽略，**不入库**）
├── shell/                 # 本插件自己写的 Rust 外壳 + HTML 桥
│   ├── Cargo.toml         # 独立 workspace，path 依赖上游 crate + wasm-release profile
│   ├── Trunk.toml         # trunk 构建配置（产物 dist/）
│   ├── index.html         # window.photocraftOtools 宿主桥（wasm-release + heif）
│   ├── src/
│   │   ├── main.rs        # 改编自上游 photocraft-web：wasm-only 外壳
│   │   ├── web.rs         # 改编自上游 apps/photocraft-web/src/web.rs（整层拷贝 + 两处改动）
│   │   ├── preset_bridge.rs   # 上游原样副本（IndexedDB 预设库桥）
│   │   ├── indexed_presets.rs # 上游原样副本（IndexedDB 读写）
│   │   ├── otools.rs      # wasm-bindgen 桥：openFiles/pickSavePath/saveFile/theme
│   │   └── download.rs    # 上游浏览器下载回退（原样副本）
│   ├── favicon.svg
│   └── patches/           # 对上游的本地裁剪补丁（随 upstream 重拉而重放）
│       └── photocraft-upstream-fix.patch
├── scripts/               # 构建 / 字体 / 打包 / 发布 / 验证
└── .github/workflows/     # 独立发布 CI
```

## 移植要点

### 1. 文件 I/O：宿主对话框替代浏览器选文件框

上游网页版没有文件系统：打开靠 `rfd` 的 `<input type=file>`，保存靠浏览器下载。
插件版把 `Services::file_dialog` 与 `Services::write` 接到 OTools 宿主：

| `FileDialogRequest` | 上游网页版 | 插件版 |
| --- | --- | --- |
| `Open`（File ▸ Open，可多选） | `rfd.pick_files()`，回答 `ContentsMany` | 宿主打开对话框 + `readHostFile`，回答 `ContentsMany` |
| `Save`（另存为） | 拿不到路径，把建议名当下载名，回答 `SaveTo(name)` | 宿主另存对话框，回答**真实路径** `SaveTo(path)` |
| `Folder` | 浏览器没有文件夹句柄，回答取消 | 同上游 |
| `Services::write` | 浏览器下载 | 宿主 `tools_webview_write_file` 写盘 |

因为另存回答的是真实路径，文档会记住自己的落盘点：之后再按「保存」直接用
`write(path, bytes)` 覆盖同一文件，不再弹对话框（与桌面版语义一致）。

不在 OTools 里（把 dist 拖进普通浏览器）时，两条路都退回上游行为——`rfd` + 浏览器下载。

### 2. 字体：随站点分发的 manifest

上游网页版把字体作为站点根下的独立文件分发：启动时 fetch `fonts/manifest.txt`
（`storytold/craft-fonts` 的清单格式），再按浏览器语言按需 fetch 具体字体。
本插件照拿同一约定：`scripts/fetch-cjk-fonts.mjs` 按 `cjk-fonts.pin` 把 craft-fonts
浅拉到 `../cjk-fonts`（兄弟目录，不入库），`scripts/prepare-fonts.mjs` 选中的字体
拷进 `dist/fonts/` 并生成 `manifest.txt`。缺字体不影响启动，只是中文/阿拉伯/泰文显示方框。

离线构建可设 `OT_FONTS_SRC=<本地 craft-fonts 检出>` 直接取文件。

### 3. 体积：复刻上游的 wasm-release profile

上游 workspace 有一套为浏览器调的 `[profile.wasm-release]`（fat LTO、`opt-level = "z"`、
按 crate 分级），`shell/Cargo.toml` 原样复刻，`shell/index.html` 用
`data-cargo-profile="wasm-release"` 选它。产物是一个 ~20MB 级的 `.wasm`。

### 4. 界面语言（跟随宿主，21 种语言）

上游网页版在 wasm 下读不到系统语言偏奾（`interface.language = auto` 恒为英文）。
插件版在首帧把 OTools 的界面语言写进偏好，中文界面就是简体中文。
在「偏好 ▸ 界面语言」里手动选过语言之后不会被覆盖。运行中切换 OTools 语言需要重开插件才会生效。

### 4. 其他

- **HEIC/HEIF**：`heif` 特性默认开启（官方构建同样默认开）。
- **预设库**：保留上游的 `preset_bridge` + `indexed_presets`（IndexedDB），
  浏览器拒绝存储时上游已有告警横幅。
- **偏好设置**：保留 localStorage。
- **压感/倾斜/扭转**：保留 Pointer Events 桥（eframe 不为笔转发这些）。
- **社区外链**：`web.rs` 的 `logic()` 吞掉所有 `OpenUrl`（Discord、ArtCraft 官网、
  上游 GitHub），点击不再跳出插件。

## 构建

```bash
unset RUSTC_WRAPPER                 # 它会把 cargo 指向旧 rustc
node scripts/build-web.mjs          # 拉上游 → 拉字体 → trunk build --release → dist/
```

需要 rustc ≥ 1.95 与 wasm32-unknown-unknown 目标（egui 0.36 的要求）。
trunk 首次运行会下载 wasm-bindgen-cli 与 wasm-opt（GitHub release），国内网络可能要直连。

## 本地验证

```bash
node scripts/probe-host-bridge.mjs  # 无头 Chromium + 假宿主：启动 / 打开 / 保存 / 覆盖
```

判定「真的启动」看 loading 节点是否被移除、canvas 是否有尺寸；宿主桥单独走一遍
打开 → 读字节 → 保存 → 同名单文件覆盖，并截图存到 `dist-pack/probe-screenshot.png`。

## 跑起来

```powershell
pwsh -File scripts/deploy-to-otools.ps1
```

然后重载/重启 OTools，应用列表里会出现「图像编辑」插件。

URL 参数沿用上游：`?cpu` 强制 CPU 画布路径、`?webgl` 强制 WebGL2 后端。

详细约定见 [AGENTS.md](./AGENTS.md)。