use crate::protocol::MAX_REQUEST_BYTES;
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    io::Write,
    process::ChildStdin,
    sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex},
};
use tauri::WebviewWindow;
use url::Url;
use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
use windows::core::PWSTR;

const MAX_PENDING: usize = 32;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "documentId")]
    document: String,
    id: u64,
    request: Value,
}

struct Pending {
    document: String,
    client_id: u64,
    generation: u64,
}

impl Pending {
    fn message(self, result: Value, error: Value) -> Value {
        serde_json::json!({"type":"glint-agent-result", "documentId":self.document,
            "id":self.client_id, "result":result, "error":error})
    }
}

fn request_line(nonce: &str, id: u64, request: Value) -> Result<Vec<u8>, String> {
    let mut line = serde_json::to_vec(&serde_json::json!({"type":"agent", "nonce":nonce, "id":id, "request":request}))
        .map_err(|_| "无法读取桌面请求。")?;
    if line.len() >= MAX_REQUEST_BYTES { return Err("请求过大。".into()); }
    line.push(b'\n');
    Ok(line)
}

pub struct AgentBridge {
    input: Arc<Mutex<ChildStdin>>,
    nonce: String,
    next_id: AtomicU64,
    generation: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
    window: Mutex<Option<WebviewWindow>>,
}

impl AgentBridge {
    pub fn new(input: Arc<Mutex<ChildStdin>>, nonce: String) -> Arc<Self> {
        Arc::new(Self { input, nonce, next_id: AtomicU64::new(0), generation: AtomicU64::new(0),
            pending: Mutex::new(HashMap::new()), window: Mutex::new(None) })
    }

    fn send(&self, id: u64, request: Value) -> Result<(), String> {
        let message = request_line(&self.nonce, id, request)?;
        let mut input = self.input.lock().map_err(|_| "桌面连接已关闭。")?;
        input.write_all(&message).map_err(|_| "桌面服务没有响应。".to_string())
    }

    pub fn invalidate(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut pending) = self.pending.lock() { pending.clear(); }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = self.send(id, serde_json::json!({"action":"detach"}));
    }

    fn receive(&self, text: &str) -> Result<(), String> {
        if text.len() > MAX_REQUEST_BYTES { return Err("请求过大。".into()); }
        let request: Request = serde_json::from_str(text).map_err(|_| "无法读取桌面请求。")?;
        if request.kind != "glint-agent" || request.id == 0 || uuid::Uuid::parse_str(&request.document).is_err() {
            return Err("无效的桌面请求。".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        {
            let mut pending = self.pending.lock().map_err(|_| "桌面连接已关闭。")?;
            if pending.len() >= MAX_PENDING { return Err("请等待当前操作完成。".into()); }
            pending.insert(id, Pending { document: request.document, client_id: request.id,
                generation: self.generation.load(Ordering::SeqCst) });
        }
        if let Err(error) = self.send(id, request.request) {
            if let Ok(mut pending) = self.pending.lock() { pending.remove(&id); }
            return Err(error);
        }
        Ok(())
    }

    pub fn fail_pending(&self, error: &str) {
        let pending = self.pending.lock().map(|mut items| items.drain().map(|(_, item)| item).collect::<Vec<_>>())
            .unwrap_or_default();
        for item in pending {
            if item.generation == self.generation.load(Ordering::SeqCst) {
                self.deliver(item.message(Value::Null, Value::String(error.into())));
            }
        }
    }

    pub fn response(&self, value: Value) {
        if value.get("type").and_then(Value::as_str) != Some("agent-result") { return; }
        let Some(id) = value.get("id").and_then(Value::as_u64) else { return; };
        let pending = self.pending.lock().ok().and_then(|mut items| items.remove(&id));
        let Some(pending) = pending else { return; };
        if pending.generation != self.generation.load(Ordering::SeqCst) { return; }
        self.deliver(pending.message(value.get("result").cloned().unwrap_or(Value::Null),
            value.get("error").cloned().unwrap_or(Value::Null)));
    }

    fn deliver(&self, message: Value) {
        let Some(window) = self.window.lock().ok().and_then(|window| window.clone()) else { return; };
        let script = format!("window.dispatchEvent(new CustomEvent('glint-native-result',{{detail:{message}}}));");
        let _ = window.eval(&script);
    }

    pub fn install(self: &Arc<Self>, window: &WebviewWindow, origin: Url) -> Result<(), String> {
        *self.window.lock().map_err(|_| "无法连接桌面窗口。")? = Some(window.clone());
        let bridge = self.clone();
        window.with_webview(move |platform| unsafe {
            let Ok(webview) = platform.controller().CoreWebView2() else { return; };
            let expected = origin;
            let mut token = 0;
            let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()); };
                let mut source = PWSTR::null();
                args.Source(&mut source)?;
                let source = take_pwstr(source);
                let Ok(source) = Url::parse(&source) else { return Ok(()); };
                if !crate::protocol::same_origin(&source, &expected) { return Ok(()); }
                let mut text = PWSTR::null();
                if args.TryGetWebMessageAsString(&mut text).is_err() { return Ok(()); }
                let text = take_pwstr(text);
                // This event belongs to the top-level WebView; frame events are not registered.
                if let Err(error) = bridge.receive(&text) { eprintln!("Desktop agent request: {error}"); }
                Ok(())
            }));
            let _ = webview.add_WebMessageReceived(&handler, &mut token);
        }).map_err(|error| format!("无法连接本地智能体：{error}"))
    }
}

pub fn script(origin: &Url) -> String {
    include_str!("agent-bridge.js").replace("__GLINT_ORIGIN__", &serde_json::to_string(&origin.origin().ascii_serialization()).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    fn request_envelope_remains_bounded_to_four_mib() {
        assert_eq!(MAX_REQUEST_BYTES, 4 * 1024 * 1024);
        let base = request_line("nonce", 1, serde_json::json!({"action":"git", "text":""})).unwrap().len();
        let exact = request_line("nonce", 1, serde_json::json!({"action":"git", "text":"x".repeat(MAX_REQUEST_BYTES - base)})).unwrap();
        assert_eq!(exact.len(), MAX_REQUEST_BYTES);
        assert!(request_line("nonce", 1, serde_json::json!({"action":"git", "text":"x".repeat(MAX_REQUEST_BYTES - base + 1)})).is_err());
        assert!(request_line("nonce", 1, serde_json::json!({"action":"git", "text":"中".repeat(MAX_REQUEST_BYTES / 3)})).is_err());
    }

    #[test]
    fn rejected_response_clears_only_current_pending_without_detaching_service() {
        let mut child = Command::new(std::env::current_exe().unwrap()).arg("--list")
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let bridge = AgentBridge::new(Arc::new(Mutex::new(child.stdin.take().unwrap())), "nonce".into());
        bridge.pending.lock().unwrap().insert(1, Pending { document: "document".into(), client_id: 99, generation: 0 });
        bridge.pending.lock().unwrap().insert(3, Pending { document: "document".into(), client_id: 101, generation: 0 });
        let error = crate::protocol::RESPONSE_TOO_LARGE;
        bridge.response(serde_json::json!({"type":"agent-result", "id":3, "error":error}));
        assert!(bridge.pending.lock().unwrap().contains_key(&1));
        assert!(!bridge.pending.lock().unwrap().contains_key(&3));
        let message = Pending { document: "document".into(), client_id: 99, generation: 0 }
            .message(Value::Null, Value::String(error.into()));
        assert_eq!(message["id"], 99);
        assert_eq!(message["documentId"], "document");
        assert_eq!(message["error"], error);
        bridge.fail_pending(error);
        assert!(bridge.pending.lock().unwrap().is_empty());
        assert_eq!(bridge.generation.load(Ordering::SeqCst), 0);
        assert_eq!(bridge.next_id.load(Ordering::Relaxed), 0);
        bridge.pending.lock().unwrap().insert(2, Pending { document: "document".into(), client_id: 100, generation: 0 });
        bridge.response(serde_json::json!({"type":"agent-result", "id":1, "result":"late"}));
        assert_eq!(bridge.pending.lock().unwrap().len(), 1);
        bridge.response(serde_json::json!({"type":"agent-result", "id":2, "result":"ok"}));
        assert!(bridge.pending.lock().unwrap().is_empty());
        assert!(bridge.receive(&"x".repeat(MAX_REQUEST_BYTES + 1)).unwrap_err().contains("请求过大"));
        child.wait().unwrap();
    }
}
