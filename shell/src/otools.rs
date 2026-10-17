//! OTools 宿主桥：把「文件从哪来、存到哪去」换成 OTools 宿主的对话框与磁盘读写。
//!
//! 上游 `apps/photocraft-web` 在浏览器里没有文件系统：打开靠 `rfd` 的
//! `<input type=file>`（拿到的是**内容**，不是路径），保存靠浏览器下载。
//! OTools 宿主注入的 `window.otools` 提供了真正的系统文件对话框与 `readHostFile` /
//! `writeHostFile`（底层是宿主的 `tools_webview_read_file` / `tools_webview_write_file`，
//! 无路径白名单限制），所以本模块是插件**唯一**需要新写的 Rust 代码：其余全部复用上游 crate。
//!
//! 与上游的对接点：
//! - `Services::file_dialog` —— `Open` 弹宿主对话框 + `readHostFile`，回答
//!   `FileDialogAnswer::ContentsMany`（wasm 下拿不到路径，与上游网页版一致）；
//!   `Save` 弹宿主另存对话框，回答**真实路径** `FileDialogAnswer::SaveTo(path)`
//!   （这样文档记住自己的落盘点，之后保存直接覆盖）；
//!   `Folder` 回答 `None`（浏览器里没有文件夹句柄，与上游一致）。
//! - `Services::write` —— 把字节交给宿主写盘（上游的 `download()` 兜底留在 `download.rs`）。
//!
//! JS 侧的实现见 `shell/index.html` 里的 `window.photocraftOtools`。

use std::cell::RefCell;

use base64::Engine as _;
use photocraft_ui_egui::{FileDialogAnswer, FileDialogRequest};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::js_sys;

/// 打开对话框的扩展名过滤，与上游 `web.rs` 的 `OPEN_EXTS` / `SVG_EXTS` 一致。
const OPEN_EXTS: &[&str] = &[
    "pcraft", "pdn", "ora", "kra", "krz", "psd", "psb", "psdt", "png", "jpg", "jpeg", "tif", "tiff", "webp", "gif", "bmp", "tga", "ico", "qoi", "exr", "hdr",
    "pbm", "pgm", "ppm", "pam", "pfm", "dds", "fits", "fit", "fts", "dpx", "cin", "heic", "heif", "hif", "dng", "cr2", "cr3", "nef", "nrw", "arw", "pef",
    "orf", "rw2", "raf", "abr", "grd", "svg", "svgz", "aco", "ase", "af", "afdesign", "afphoto", "afpub",
];

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = photocraftOtools, js_name = "available")]
    fn host_available() -> bool;

    #[wasm_bindgen(js_namespace = photocraftOtools, js_name = "theme")]
    fn host_theme() -> String;

    /// `{title, filters, multiple}` → `[{name, path, dataBase64}]`（用户取消时空数组）。
    #[wasm_bindgen(js_namespace = photocraftOtools, js_name = "openFiles")]
    fn host_open_files(request: JsValue) -> js_sys::Promise;

    /// `{name, dataBase64, forcePick}` → `{path}` 或 `null`（用户取消）。
    #[wasm_bindgen(js_namespace = photocraftOtools, js_name = "saveFile")]
    fn host_save_file(request: JsValue) -> js_sys::Promise;

    /// `{name}` → `{path}` 或 `null`（用户取消）：只选路径，不写文件。
    #[wasm_bindgen(js_namespace = photocraftOtools, js_name = "pickSavePath")]
    fn host_pick_save_path(request: JsValue) -> js_sys::Promise;
}

thread_local! {
    /// 缓存 egui Context，供异步任务完成后触发重绘。
    static REPAINT: RefCell<Option<egui::Context>> = const { RefCell::new(None) };
}

/// 宿主是否可用（不在 OTools 里时退回上游的浏览器行为：下载文件）。
pub fn available() -> bool {
    host_available()
}

/// OTools 的界面主题，用于给 egui 一个初始亮度（`""` = 跟随系统）。
pub fn theme() -> String {
    host_theme()
}

pub(crate) fn repaint() {
    REPAINT.with(|slot| {
        if let Some(ctx) = slot.borrow().as_ref() {
            ctx.request_repaint();
        }
    });
}

/// 装上重绘句柄（启动时调用一次）。
pub fn install(ctx: egui::Context) {
    REPAINT.with(|slot| *slot.borrow_mut() = Some(ctx));
}

/// 社区/外部链接（Discord、ArtCraft 官网、上游 GitHub）：插件里点击不再跳出。
pub fn is_community_url(url: &str) -> bool {
    url.contains("discord.gg") || url.contains("getartcraft.com") || url.contains("github.com/storytold")
}

/// 宿主版 `Services::file_dialog`：见模块文档。
pub fn file_dialog(request: FileDialogRequest, _parent: Option<&eframe::Frame>, reply: photocraft_ui_egui::file_dialog::FileDialogReply) {
    match request {
        // 浏览器/wasm 拿不到路径：对话框读到的字节直接交给应用（与上游网页版同一条路）。
        FileDialogRequest::Open { multiple, extensions, .. } => {
            let (title, filters) = open_filters(extensions.as_deref());
            let request = open_request(title, filters, multiple);
            wasm_bindgen_futures::spawn_local(async move {
                let answer = match open_files(&request).await {
                    Ok(files) if !files.is_empty() => Some(if multiple {
                        FileDialogAnswer::ContentsMany(files)
                    } else {
                        let (name, bytes) = files.into_iter().next().unwrap_or_default();
                        FileDialogAnswer::Contents(name, bytes)
                    }),
                    Ok(_) => None,
                    Err(e) => {
                        log::error!("打开失败：{e}");
                        Some(FileDialogAnswer::Unavailable(e))
                    }
                };
                reply.send(answer);
                repaint();
            });
        }
        // 浏览器文件夹句柄表达不成路径，与上游一致回答取消。
        FileDialogRequest::Folder { .. } => reply.send(None),
        // 另存：弹宿主对话框拿**真实路径**，之后保存直接覆盖它。
        FileDialogRequest::Save { suggested } => {
            let name = std::path::Path::new(&suggested).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(suggested.clone());
            let request = save_name_request(&name);
            wasm_bindgen_futures::spawn_local(async move {
                let answer = match pick_save_path(&request).await {
                    Ok(Some(path)) => Some(FileDialogAnswer::SaveTo(path)),
                    Ok(None) => None,
                    Err(e) => {
                        log::error!("保存失败：{e}");
                        Some(FileDialogAnswer::Unavailable(e))
                    }
                };
                reply.send(answer);
                repaint();
            });
        }
    }
}

/// 宿主版 `Services::write`：把字节交给宿主写盘。上游的钩子是同步 `fn`，而宿主的对话框是
/// Promise，所以这里发起一次后台任务并立刻返回 `Ok`（与上游网页版「下载已开始即算已保存」一致）。
pub fn write(path: &str, bytes: &[u8]) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("需要一个文件名".into());
    }
    let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string());
    let request = save_request(&name, &base64::engine::general_purpose::STANDARD.encode(bytes), false);
    wasm_bindgen_futures::spawn_local(async move {
        match save_file(&request).await {
            Ok(Some(p)) => log::info!("saved {name} -> {p}"),
            Ok(None) => log::error!("保存已取消：{name}"),
            Err(e) => log::error!("保存失败：{name}：{e}"),
        }
        repaint();
    });
    Ok(())
}

/// 上游的打开过滤器：有 extensions 用它的，否则「全部支持格式 + SVG」两组。
fn open_filters(extensions: Option<&[String]>) -> (&'static str, Vec<String>) {
    match extensions {
        Some(exts) if !exts.is_empty() => ("Supported Files", exts.iter().map(|e| e.trim_start_matches('.').to_string()).collect()),
        _ => ("Supported Files", OPEN_EXTS.iter().map(|e| (*e).to_string()).collect()),
    }
}

fn open_request(title: &str, exts: Vec<String>, multiple: bool) -> JsValue {
    let request = js_sys::Object::new();
    let arr = js_sys::Array::new();
    for e in &exts {
        arr.push(&JsValue::from_str(e));
    }
    let filters = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&filters, &JsValue::from_str("name"), &JsValue::from_str(title));
    let _ = js_sys::Reflect::set(&filters, &JsValue::from_str("extensions"), &arr);
    let filter_arr = js_sys::Array::of1(&filters);
    let _ = js_sys::Reflect::set(&request, &JsValue::from_str("title"), &JsValue::from_str("打开文件"));
    let _ = js_sys::Reflect::set(&request, &JsValue::from_str("filters"), &filter_arr);
    let _ = js_sys::Reflect::set(&request, &JsValue::from_str("multiple"), &JsValue::from_bool(multiple));
    request.into()
}

async fn open_files(request: &JsValue) -> Result<Vec<(String, Vec<u8>)>, String> {
    let value = JsFuture::from(host_open_files(request.clone())).await.map_err(js_error)?;
    let mut out = Vec::new();
    for entry in js_sys::Array::from(&value).iter() {
        let name = field(&entry, "name").unwrap_or_else(|| "untitled".to_string());
        let data = field(&entry, "dataBase64").unwrap_or_default();
        let bytes = base64_decode(&data)?;
        out.push((name, bytes));
    }
    Ok(out)
}

fn save_request(name: &str, data: &str, force_pick: bool) -> JsValue {
    let request = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&request, &JsValue::from_str("name"), &JsValue::from_str(name));
    let _ = js_sys::Reflect::set(&request, &JsValue::from_str("dataBase64"), &JsValue::from_str(data));
    let _ = js_sys::Reflect::set(&request, &JsValue::from_str("forcePick"), &JsValue::from_bool(force_pick));
    request.into()
}

/// 只选路径（另存对话框）：不写任何字节。
fn save_name_request(name: &str) -> JsValue {
    let request = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&request, &JsValue::from_str("name"), &JsValue::from_str(name));
    request.into()
}

async fn pick_save_path(request: &JsValue) -> Result<Option<String>, String> {
    let value = JsFuture::from(host_pick_save_path(request.clone())).await.map_err(js_error)?;
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    Ok(field(&value, "path"))
}

async fn save_file(request: &JsValue) -> Result<Option<String>, String> {
    let value = JsFuture::from(host_save_file(request.clone())).await.map_err(js_error)?;
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    Ok(field(&value, "path"))
}

fn base64_decode(data: &str) -> Result<Vec<u8>, String> {
    if data.is_empty() {
        return Err("宿主返回的文件内容为空".into());
    }
    base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| format!("宿主返回的内容不是合法的 base64：{e}"))
}

fn field(value: &JsValue, key: &str) -> Option<String> {
    js_sys::Reflect::get(value, &JsValue::from_str(key)).ok()?.as_string()
}

fn js_error(e: JsValue) -> String {
    e.as_string().unwrap_or_else(|| format!("{e:?}"))
}