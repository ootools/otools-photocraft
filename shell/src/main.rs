//! PhotoCraft 的 OTools 插件外壳。
//!
//! 本文件改编自上游 `apps/photocraft-web/src/main.rs` + `src/web.rs`：
//! UI 仍然是上游的 `photocraft_ui_egui::PhotocraftApp`（原封不动），
//! 唯一的区别是「文件从哪来、存到哪去」：
//!
//! 1. `Services::file_dialog` —— `Open` 弹宿主打开对话框并读字节（回答 `ContentsMany`），
//!    `Save` 弹宿主另存对话框并回答**真实路径**；不在 OTools 里才退回上游的 `rfd` + 下载；
//! 2. `Services::write` —— 在 OTools 里把字节交给宿主写盘；
//! 3. `logic()` 里吞掉社区外链。
//!
//! 上游 `crates/*` 一律不改：它们按 upstream.pin 的 commit 拉取，保持原样才能干净地跟上上游。
//! 字体（`dist/fonts/manifest.txt` + 字体文件）由 `scripts/prepare-fonts.mjs` 在构建期就位，
//! 上游的 served_fonts 逻辑原样工作。

#[cfg(target_arch = "wasm32")]
mod download;
#[cfg(target_arch = "wasm32")]
mod indexed_presets;
#[cfg(target_arch = "wasm32")]
mod otools;
#[cfg(target_arch = "wasm32")]
mod preset_bridge;
#[cfg(target_arch = "wasm32")]
mod web;

#[cfg(target_arch = "wasm32")]
fn main() {
    web::start();
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    // 外壳是 wasm-only 的：宿主（x86_64）下 cargo build 会走到这里，别把它当编译报错。
    eprintln!("otools-photocraft only runs in a webview: build it with `trunk build --release` in shell/");
}
