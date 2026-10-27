//! 在 dylib 内驱动上游 `rmcp` 服务端的常驻客户端。
//!
//! 上游 `photocraft-automation` 只公开了一个 MCP 服务端（`PhotocraftMcp`），工具表由
//! `#[tool_router]` 宏生成、没有独立导出。为了不重写任何工具定义，这里起一个
//! **进程内**的上游服务，用 `tokio::io::duplex` 做两条内存管道接 `serve_io`：
//!
//! ```text
//!  宿主 FFI 线程 ──┐                        ┌── serve_io 的 input 端
//!                  ├─ client_write ──duplex──┘
//!                  │                        ┌── serve_io 的 output 端
//!                  └─ client_read  ◀─duplex─┘
//! ```
//!
//! 请求按 JSON-RPC 的 `id` 与等待位配对，因此可以并发。服务实例常驻：`doc_open` →
//! `doc_inspect` → `doc_save` 这类有状态工具序列落在同一个会话上。
//!
//! **为什么不自己 parse 上游的工具宏**：宏生成的 schema/校验/作业逻辑是上游真源，
//! 复制一份必然漂移；经协议转发则永远同步。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

/// 单次请求上限。导出/渲染类工具可能跑很久，这里给足余量。
const CALL_TIMEOUT: Duration = Duration::from_secs(600);
/// 取工具表很快，不需要长超时。
const LIST_TIMEOUT: Duration = Duration::from_secs(60);

type Waiters = Mutex<HashMap<u64, oneshot::Sender<Value>>>;

/// 常驻服务的句柄：runtime 必须一直活着，管道写端只有一条。
pub struct Bridge {
    runtime: tokio::runtime::Runtime,
    writer: tokio::sync::Mutex<tokio::io::DuplexStream>,
}

/// 用 `Mutex<Option<..>>` 而不是 `OnceLock`：`__otools_shutdown__` 要能把常驻服务
/// 取走并释放（runtime 线程、管道、上游会话），之后还能按需重建。
/// `OnceLock` 做不到重置，热更新时旧库的资源会一直挂到进程退出。
static BRIDGE: OnceLock<Mutex<Option<Bridge>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn bridge_slot() -> &'static Mutex<Option<Bridge>> {
    BRIDGE.get_or_init(|| Mutex::new(None))
}

/// 释放常驻服务：取走 `Bridge` 并丢弃，runtime 随之停机、管道与上游会话一并回收。
/// 供宿主热更新前的 `__otools_shutdown__` 调用；之后再调用工具会重建一个新服务。
pub fn shutdown() {
    let taken = match bridge_slot().lock() {
        Ok(mut slot) => slot.take(),
        // 锁中毒说明上一次调用 panic 过；用 into_inner 强行取出，避免把资源永久滞留。
        Err(poisoned) => poisoned.into_inner().take(),
    };
    // 等后台任务收尾，避免紧接 drop 时任务仍在写管道。
    if let Some(bridge) = taken {
        bridge.runtime.shutdown_background();
    }
}

fn waiters() -> &'static Waiters {
    static WAITERS: OnceLock<Waiters> = OnceLock::new();
    WAITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

impl Bridge {
    /// 建服务、跑 `initialize` 握手。失败信息原样返回给调用方（宿主会包装成 isError）。
    fn start() -> Result<Self, String> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| format!("无法启动 MCP runtime: {e}"))?;

        let (client_write, server_read) = tokio::io::duplex(1 << 20);
        let (server_write, client_read) = tokio::io::duplex(1 << 20);

        let server = photocraft_automation::PhotocraftMcp::headless();
        runtime.spawn(async move {
            if let Err(e) = server.serve_io(server_read, server_write).await {
                eprintln!("[photocraft-native] 上游 MCP 服务退出: {e}");
            }
        });

        runtime.spawn(async move {
            let mut lines = BufReader::new(client_read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let Some(id) = msg.get("id").and_then(Value::as_u64) else {
                    continue; // 通知 / 服务端主动消息，宿主契约里用不到
                };
                let sender = match waiters().lock() {
                    Ok(mut map) => map.remove(&id),
                    Err(_) => None,
                };
                if let Some(sender) = sender {
                    let _ = sender.send(msg);
                }
            }
        });

        let bridge = Bridge {
            runtime,
            writer: tokio::sync::Mutex::new(client_write),
        };

        // `initialize` 是协议要求的第一步；不发它，服务端会拒绝后续请求。
        let init = bridge.request(
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "otools-host", "version": env!("CARGO_PKG_VERSION") }
            }),
            LIST_TIMEOUT,
        )?;
        if init.get("error").is_some() {
            return Err(format!("上游 MCP 初始化失败: {init}"));
        }
        bridge.notify("notifications/initialized", json!({}))?;

        Ok(bridge)
    }

    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel::<Value>();
        {
            let mut map = waiters()
                .lock()
                .map_err(|_| "MCP 等待位表已锁死".to_string())?;
            map.insert(id, sender);
        }
        let line =
            json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();

        let sent = self.runtime.block_on(async {
            let mut writer = self.writer.lock().await;
            writer.write_all(format!("{line}\n").as_bytes()).await
        });
        if let Err(e) = sent {
            if let Ok(mut map) = waiters().lock() {
                map.remove(&id);
            }
            return Err(format!("写入上游 MCP 通道失败: {e}"));
        }

        match self
            .runtime
            .block_on(async { tokio::time::timeout(timeout, receiver).await })
        {
            Ok(Ok(msg)) => Ok(msg),
            Ok(Err(_)) => Err("上游 MCP 通道已关闭".to_string()),
            Err(_) => {
                if let Ok(mut map) = waiters().lock() {
                    map.remove(&id);
                }
                Err(format!(
                    "上游 MCP 在 {}s 内没有响应（{method}）",
                    timeout.as_secs()
                ))
            }
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let line = json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string();
        self.runtime
            .block_on(async {
                let mut writer = self.writer.lock().await;
                writer.write_all(format!("{line}\n").as_bytes()).await
            })
            .map_err(|e| format!("写入上游 MCP 通道失败: {e}"))
    }
}

/// 取常驻服务；没有就建一个。
///
/// 不能返回 `&'static Bridge`（已被 `Mutex<Option<..>>` 包住），所以返回持有锁的
/// 守卫。调用方在 `request` 期间一直持有它，天然串行化——这与单条管道写端的事实一致。
fn bridge() -> Result<std::sync::MutexGuard<'static, Option<Bridge>>, String> {
    let mut slot = bridge_slot()
        .lock()
        .map_err(|_| "常驻 MCP 服务状态已损坏，请重启 OTools".to_string())?;
    if slot.is_none() {
        *slot = Some(Bridge::start()?);
    }
    Ok(slot)
}

/// 取上游工具表（已经是 MCP Tool 对象）。
pub fn list_tools() -> Result<Vec<Value>, String> {
    let guard = bridge()?;
    let bridge = guard.as_ref().ok_or("常驻 MCP 服务未就绪")?;
    let response = bridge.request("tools/list", json!({}), LIST_TIMEOUT)?;
    if let Some(error) = response.get("error") {
        return Err(format!("上游 tools/list 失败: {error}"));
    }
    Ok(response
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// 上游 `resources/list`。
///
/// 上游提供两个资源（`upstream/crates/automation/src/server/conventions.rs`）：
/// `photocraft://document`（当前文档 / 空会话）与 `photocraft://commands`（命令目录）。
/// 这里原样转发 `result`，不复制资源定义。
pub fn list_resources() -> Result<Value, String> {
    request_result("resources/list", json!({}), LIST_TIMEOUT)
}

pub fn list_resource_templates() -> Result<Value, String> {
    request_result("resources/templates/list", json!({}), LIST_TIMEOUT)
}

/// 读资源；未知 uri 由上游返回 `unknown resource`，这里归一成 `Err`。
pub fn read_resource(uri: &str) -> Result<Value, String> {
    request_result("resources/read", json!({ "uri": uri }), LIST_TIMEOUT)
}

/// 发一条请求并取出 `result`；协议层错误转成 `Err`（resources 没有 isError 信封）。
fn request_result(method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let guard = bridge()?;
    let bridge = guard.as_ref().ok_or("常驻 MCP 服务未就绪")?;
    let response = bridge.request(method, params, timeout)?;
    if let Some(error) = response.get("error") {
        let text = error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| error.to_string());
        return Err(text);
    }
    Ok(response.get("result").cloned().unwrap_or(json!({})))
}

/// 调用一个上游工具，返回 MCP 形状的 `{content, isError}`。
pub fn call_tool(name: &str, arguments: &Value) -> Result<Value, String> {
    let guard = bridge()?;
    let bridge = guard.as_ref().ok_or("常驻 MCP 服务未就绪")?;
    let response = bridge.request(
        "tools/call",
        json!({ "name": name, "arguments": arguments }),
        CALL_TIMEOUT,
    )?;

    // 协议层错误（工具不存在 / 参数不符）也归一成 isError，宿主只认这一种形状。
    if let Some(error) = response.get("error") {
        let text = error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| error.to_string());
        return Ok(json!({
            "content": [{ "type": "text", "text": text }],
            "isError": true
        }));
    }

    let result = response.get("result").cloned().unwrap_or(json!({}));
    let content = result
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let is_error = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(json!({ "content": content, "isError": is_error }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // 这些用例共享进程内的常驻服务（这本身就是被测行为），必须串行执行：
    // `cargo test -- --test-threads=1`。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn tools_list_comes_from_the_upstream_router() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tools = list_tools().expect("upstream tools/list");
        assert!(!tools.is_empty(), "上游工具表不应为空");
        for tool in &tools {
            assert!(
                tool.get("name").and_then(Value::as_str).is_some(),
                "每个工具都需要 name: {tool}"
            );
            assert!(
                tool.get("inputSchema").is_some(),
                "每个工具都需要 inputSchema: {tool}"
            );
        }
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|t| t.get("name").and_then(Value::as_str))
            .collect();
        assert!(names.contains(&"session_list"), "got {names:?}");
        assert!(names.contains(&"command_run"), "got {names:?}");
    }

    #[test]
    fn unknown_tool_is_reported_as_is_error() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let result = call_tool("definitely_not_a_tool", &json!({})).expect("bridge");
        assert_eq!(result["isError"], true, "result: {result}");
        assert!(result["content"].as_array().is_some_and(|c| !c.is_empty()));
    }

    #[test]
    fn read_only_tool_succeeds_headless() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let result = call_tool("session_list", &json!({})).expect("bridge");
        assert_eq!(result["isError"], false, "result: {result}");
        assert!(
            result["content"].as_array().is_some_and(|c| !c.is_empty()),
            "must return MCP content: {result}"
        );
    }

    fn tool_names() -> (std::sync::MutexGuard<'static, ()>, Vec<String>) {
        let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let names = list_tools()
            .expect("upstream tools/list")
            .iter()
            .filter_map(|t| t.get("name").and_then(Value::as_str).map(str::to_string))
            .collect();
        (guard, names)
    }

    /// `plugin.json` 的 `mcp.expose` 是对外白名单初值。若它列了上游不存在的工具名，
    /// 宿主设置页会出现永远勾不上的条目；工具改名时这里必须同步。这条测试就是防漂移。
    #[test]
    fn plugin_manifest_expose_matches_upstream_tools() {
        let (_guard, names) = tool_names();
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugin.json");
        let raw = std::fs::read_to_string(&manifest)
            .unwrap_or_else(|e| panic!("读取 {} 失败: {e}", manifest.display()));
        let parsed: serde_json::Value =
            serde_json::from_str(&raw).expect("plugin.json 必须是合法 JSON");
        let expose = parsed["mcp"]["expose"]
            .as_array()
            .expect("plugin.json 必须声明 mcp.expose");
        let exposed: Vec<String> = expose
            .iter()
            .map(|item| item.as_str().unwrap_or_default().to_string())
            .collect();

        // 方向一：expose 不能列出上游没有的工具（否则设置页出现永远勾不上的死条目）。
        let unknown: Vec<&String> = exposed
            .iter()
            .filter(|name| !names.iter().any(|n| n == *name))
            .collect();
        assert!(
            unknown.is_empty(),
            "plugin.json 的 mcp.expose 含上游不存在的工具: {unknown:?}；上游实际有 {names:?}"
        );

        // 方向二（「不能少功能」的守门员）：上游每个工具都必须在 expose 里。
        // 上游新增工具时这条会红，提醒同步 expose，避免新能力静默不可见。
        let missing: Vec<&String> = names.iter().filter(|n| !exposed.contains(n)).collect();
        assert!(
            missing.is_empty(),
            "上游有工具但 plugin.json 的 mcp.expose 未列出（新能力会不可见）: {missing:?}"
        );
    }

    // ── resources ────────────────────────────────────────────────────────────
    //
    // 上游 photocraft 提供两个资源（`upstream/crates/automation/src/server/conventions.rs`
    // 的 `list_resources` / `read_resource`）：`photocraft://document` 与
    // `photocraft://commands`。这里锁死 URI 与「能真读回内容」，上游改名会立刻红。
    //
    // ⚠️ 之前曾误判「photocraft 上游没有 resources」——原因是只 grep 了
    // `upstream/crates/*/src/*.rs` 一层，而实现实际在 `src/server/conventions.rs`
    // 子目录里。查上游能力必须递归找。

    #[test]
    fn resources_list_forwards_upstream_catalog() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let result = list_resources().expect("上游应答得上 resources/list");
        let items = result
            .get("resources")
            .and_then(Value::as_array)
            .expect("result 里必须有 resources 数组");

        let uris: Vec<&str> = items
            .iter()
            .filter_map(|r| r.get("uri").and_then(Value::as_str))
            .collect();
        assert!(
            uris.contains(&"photocraft://document"),
            "缺少文档资源，got {uris:?}"
        );
        assert!(
            uris.contains(&"photocraft://commands"),
            "缺少命令目录资源，got {uris:?}"
        );
        for item in items {
            assert!(
                item.get("name").and_then(Value::as_str).is_some(),
                "资源缺少 name: {item}"
            );
            assert!(
                item.get("mimeType").and_then(Value::as_str).is_some(),
                "资源缺少 mimeType: {item}"
            );
        }
    }

    #[test]
    fn read_resource_returns_upstream_contents() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let result = read_resource("photocraft://commands").expect("上游 resources/read");
        let contents = result
            .get("contents")
            .and_then(Value::as_array)
            .expect("result 里必须有 contents 数组");
        assert!(!contents.is_empty(), "资源内容不应为空: {result}");
        let text = contents[0]
            .get("text")
            .and_then(Value::as_str)
            .expect("文本资源必须有 text 字段");
        assert!(!text.trim().is_empty(), "资源文本不应为空");
    }

    #[test]
    fn unknown_resource_uri_is_an_error() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let error = read_resource("photocraft://missing").expect_err("未知资源必须报错");
        assert!(
            error.to_lowercase().contains("not found") || error.to_lowercase().contains("resource"),
            "错误信息应说明资源不存在: {error}"
        );
    }

    #[test]
    fn resource_templates_is_empty_but_answered() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // 上游没有声明任何带参数的 URI 模板，但方法必须答得上（空表而非 method not found）。
        let result = list_resource_templates().expect("应答得上 resources/templates/list");
        let items = result
            .get("resourceTemplates")
            .or_else(|| result.get("resource_templates"))
            .and_then(Value::as_array)
            .expect("result 里必须有 resourceTemplates 数组");
        assert!(items.is_empty(), "{result}");
    }

    /// 与工具面同一条守门逻辑：`plugin.json` 的 `mcp.resources` 必须与上游实际资源双向一致。
    #[test]
    fn plugin_manifest_resources_match_upstream() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let actual: Vec<String> = list_resources()
            .expect("upstream resources/list")
            .get("resources")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|r| r.get("uri").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();

        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugin.json");
        let raw = std::fs::read_to_string(&manifest)
            .unwrap_or_else(|e| panic!("读取 {} 失败: {e}", manifest.display()));
        let parsed: serde_json::Value =
            serde_json::from_str(&raw).expect("plugin.json 必须是合法 JSON");
        let declared: Vec<String> = parsed["mcp"]["resources"]
            .as_array()
            .expect("plugin.json 必须声明 mcp.resources")
            .iter()
            .map(|item| item.as_str().unwrap_or_default().to_string())
            .collect();

        let missing: Vec<&String> = actual.iter().filter(|u| !declared.contains(u)).collect();
        assert!(
            missing.is_empty(),
            "上游有资源但 plugin.json 的 mcp.resources 未列出: {missing:?}；实际 {actual:?}"
        );
        let extra: Vec<&String> = declared.iter().filter(|u| !actual.contains(u)).collect();
        assert!(
            extra.is_empty(),
            "plugin.json 的 mcp.resources 含上游不存在的 uri: {extra:?}；实际 {actual:?}"
        );
    }

    /// 停机握手必须真正释放，且之后还能重建：宿主热更新时旧库被卸载、
    /// 新库重新加载，若 `OnceLock` 那种不可重置的槽位还在，旧 runtime 会一直挂着。
    #[test]
    fn shutdown_releases_and_allows_restart() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        list_tools().expect("首次取工具表");
        shutdown();
        // 释放后再取，必须能重新握手成功（而不是返回陈旧句柄或永久失败）。
        let tools = list_tools().expect("停机后应能重建服务");
        assert!(!tools.is_empty(), "重建后工具表不应为空");
    }
}
