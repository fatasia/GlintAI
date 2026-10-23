use serde::Deserialize;
use std::io::{self, BufRead, Read};
use url::Url;

pub const MAX_READY_LINE: usize = 4096;

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
