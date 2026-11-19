use serde::Deserialize;
use std::io::{self, BufRead, Read};
use url::Url;

pub const MAX_READY_LINE: usize = 4096;
pub const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
// 完整 NDJSON envelope（含换行）；不改变 Git host 的 12MiB 输出契约。
pub const MAX_RESPONSE_BYTES: usize = 12 * 1024 * 1024 + 64 * 1024;
pub const RESPONSE_TOO_LARGE: &str = "桌面服务响应过大，请缩小查询范围后重试。";

pub enum Response {
    Message(serde_json::Value),
    Rejected(&'static str),
    RequestRejected { id: u64, error: &'static str },
    Eof,
}

pub fn read_response(reader: &mut impl BufRead) -> io::Result<Response> {
    let mut line = Vec::with_capacity(MAX_RESPONSE_BYTES + 1);
    reader.by_ref().take((MAX_RESPONSE_BYTES + 1) as u64).read_until(b'\n', &mut line)?;
    if line.len() > MAX_RESPONSE_BYTES {
        // 只有完整 JSON 才能安全取 id；不从截断前缀猜测，以免完成错误请求。
        if line.ends_with(b"\n") {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&line) {
                if value.get("type").and_then(serde_json::Value::as_str) == Some("agent-result") {
                    if let Some(id) = value.get("id").and_then(serde_json::Value::as_u64) {
                        return Ok(Response::RequestRejected { id, error: RESPONSE_TOO_LARGE });
                    }
                }
            }
        } else {
            loop {
                let chunk = reader.fill_buf()?;
                if chunk.is_empty() { break; }
                let end = chunk.iter().position(|byte| *byte == b'\n');
                let consumed = end.map_or(chunk.len(), |end| end + 1);
                reader.consume(consumed);
                if end.is_some() { break; }
            }
        }
        return Ok(Response::Rejected(RESPONSE_TOO_LARGE));
    }
    if line.is_empty() { return Ok(Response::Eof); }
    if !line.ends_with(b"\n") {
        return Ok(Response::Rejected("桌面服务响应不完整，请重试。"));
    }
    Ok(match serde_json::from_slice(&line) {
        Ok(value) => Response::Message(value),
        Err(_) => Response::Rejected("无法读取桌面服务响应，请重试。"),
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ready {
    #[serde(rename = "type")]
    kind: String,
    url: String,
    nonce: String,
}

pub fn read_ready(reader: &mut impl BufRead, nonce: &str) -> Result<Url, String> {
    let mut line = Vec::new();
    reader
        .take((MAX_READY_LINE + 1) as u64)
        .read_until(b'\n', &mut line)
        .map_err(|_| "Cannot read desktop service readiness".to_string())?;
    if line.len() > MAX_READY_LINE || !line.ends_with(b"\n") {
        return Err("Desktop service readiness line missing, incomplete, or too large".into());
    }
    let ready: Ready = serde_json::from_slice(&line)
        .map_err(|_| "Desktop service returned invalid readiness JSON".to_string())?;
    if ready.kind != "ready" || ready.nonce != nonce {
        return Err("Desktop service readiness type/nonce mismatch".into());
    }
    validate_owned_url(&ready.url)
}

pub fn validate_owned_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid desktop service URL".to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.port() == Some(0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Desktop service must return a bare http://127.0.0.1:<dynamic-port> origin".into(),
        );
    }
    Ok(url)
}

pub fn same_origin(candidate: &Url, owned: &Url) -> bool {
    candidate.origin() == owned.origin()
        && candidate.username().is_empty()
        && candidate.password().is_none()
}

pub fn drain(reader: &mut impl Read) {
    let _ = io::copy(reader, &mut io::sink());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn message(url: &str, nonce: &str) -> Vec<u8> {
        format!(
            "{}\n",
            serde_json::json!({"type":"ready", "url":url, "nonce":nonce})
        )
        .into_bytes()
    }

    #[test]
    fn accepts_git_like_response_larger_than_request_limit() {
        let text = "差分".repeat(900_000);
        let value = serde_json::json!({"type":"agent-result", "id":7,
            "result":{"files":[{"path":"project.json", "before":text, "after":"next"}]}});
        let mut line = serde_json::to_vec(&value).unwrap();
        line.push(b'\n');
        assert!(line.len() > MAX_REQUEST_BYTES);
        let Response::Message(actual) = read_response(&mut Cursor::new(line)).unwrap() else { panic!("合法大响应被拒绝"); };
        assert_eq!(actual, value);
    }

    #[test]
    fn response_limit_counts_entire_envelope_and_newline() {
        let prefix = b"{\"type\":\"agent-result\",\"id\":1,\"result\":\"";
        let mut line = prefix.to_vec();
        line.resize(MAX_RESPONSE_BYTES - 3, b'x');
        line.extend_from_slice(b"\"}\n");
        assert_eq!(line.len(), MAX_RESPONSE_BYTES);
        assert!(matches!(read_response(&mut Cursor::new(&line)).unwrap(), Response::Message(_)));
        line.insert(prefix.len(), b'x');
        assert!(matches!(read_response(&mut Cursor::new(line)).unwrap(),
            Response::RequestRejected { id: 1, error: RESPONSE_TOO_LARGE }));
    }

    #[test]
    fn drains_oversized_line_and_resumes_at_next_record() {
        let oversized = std::io::repeat(b'x').take((MAX_RESPONSE_BYTES * 3) as u64);
        let next = Cursor::new(b"\n{\"type\":\"agent-result\",\"id\":2,\"result\":true}\n");
        let mut reader = std::io::BufReader::with_capacity(127, oversized.chain(next));
        assert!(matches!(read_response(&mut reader).unwrap(), Response::Rejected(RESPONSE_TOO_LARGE)));
        let Response::Message(value) = read_response(&mut reader).unwrap() else { panic!("后续响应丢失"); };
        assert_eq!(value["id"], 2);
        assert!(matches!(read_response(&mut reader).unwrap(), Response::Eof));
    }

    #[test]
    fn rejects_unterminated_and_invalid_records_without_leaking_content() {
        for size in [0, 50, MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES + 1] {
            let mut reader = std::io::BufReader::new(std::io::repeat(b'x').take(size as u64));
            match read_response(&mut reader).unwrap() {
                Response::Eof => assert_eq!(size, 0),
                Response::Rejected(error) => assert!(!error.contains('x')),
                Response::Message(_) | Response::RequestRejected { .. } => panic!("接受了未终止响应"),
            }
            assert!(matches!(read_response(&mut reader).unwrap(), Response::Eof));
        }
        let mut reader = Cursor::new(b"SECRET-PROVIDER-OUTPUT\n{\"id\":2}\n");
        assert!(matches!(read_response(&mut reader).unwrap(), Response::Rejected(_)));
        assert!(matches!(read_response(&mut reader).unwrap(), Response::Message(_)));
    }

    #[test]
    fn accepts_only_nonce_bound_loopback_readiness() {
        let ready = read_ready(
            &mut Cursor::new(message("http://127.0.0.1:48123", "secret")),
            "secret",
        )
        .unwrap();
        assert_eq!(ready.port(), Some(48123));
        assert!(read_ready(
            &mut Cursor::new(message("http://127.0.0.1:48123", "wrong")),
            "secret"
        )
        .is_err());
    }

    #[test]
    fn rejects_unowned_or_decorated_urls() {
        for value in [
            "https://127.0.0.1:443",
            "http://localhost:3000",
            "http://127.0.0.2:3000",
            "http://127.0.0.1",
            "http://127.0.0.1:0",
            "http://user@127.0.0.1:3000",
            "http://127.0.0.1:3000/path",
            "http://127.0.0.1:3000/?x=1",
            "http://127.0.0.1:3000/#x",
        ] {
            assert!(validate_owned_url(value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn rejects_malformed_oversized_incomplete_and_unexpected_messages() {
        for bytes in [
            vec![],
            b"not json\n".to_vec(),
            vec![b'x'; MAX_READY_LINE + 1],
            b"{\"type\":\"ready\",\"nonce\":\"n\",\"url\":\"http://127.0.0.1:1234\"}".to_vec(),
            b"{\"type\":\"shutdown\",\"nonce\":\"n\",\"url\":\"http://127.0.0.1:1234\"}\n".to_vec(),
        ] {
            assert!(read_ready(&mut Cursor::new(bytes), "n").is_err());
        }
    }

    #[test]
    fn navigation_is_pinned_to_exact_owned_origin() {
        let owned = validate_owned_url("http://127.0.0.1:4567").unwrap();
        assert!(same_origin(
            &owned.join("/editor?project=one#scene").unwrap(),
            &owned
        ));
        for value in [
            "http://127.0.0.1:4568",
            "https://example.com",
            "file:///C:/secret",
            "tauri://localhost",
            "javascript:alert(1)",
        ] {
            assert!(!same_origin(&Url::parse(value).unwrap(), &owned));
        }
    }
}
