//! File I/O. Binary payloads travel as raw IPC bodies (no JSON number arrays).

use tauri::ipc::{InvokeBody, Request, Response};

#[tauri::command]
pub async fn read_file(path: String) -> Result<Response, String> {
    let data = tokio::fs::read(&path).await.map_err(|e| format!("{path}: {e}"))?;
    Ok(Response::new(data))
}

#[tauri::command]
pub async fn write_file(request: Request<'_>) -> Result<(), String> {
    let path = header(&request, "x-path")?;
    let data = raw_body(&request)?;
    tokio::fs::write(&path, data).await.map_err(|e| format!("{path}: {e}"))
}

pub fn raw_body<'a>(req: &'a Request<'_>) -> Result<&'a [u8], String> {
    match req.body() {
        InvokeBody::Raw(b) => Ok(b),
        _ => Err("expected a raw byte payload".into()),
    }
}

/// Reads a percent-encoded header value.
pub fn header(req: &Request<'_>, name: &str) -> Result<String, String> {
    let v = req
        .headers()
        .get(name)
        .ok_or_else(|| format!("missing header {name}"))?
        .to_str()
        .map_err(|e| e.to_string())?;
    percent_decode(v)
}

fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn decodes() {
        assert_eq!(super::percent_decode("%2FUsers%2Fa%20b%C3%A9").unwrap(), "/Users/a bé");
        assert_eq!(super::percent_decode("plain").unwrap(), "plain");
    }
}
