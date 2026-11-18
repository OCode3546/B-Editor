//! External tool processes: clang / rustc (source → assembly / object), Python (source → bytecode),
//! Ghidra headless (binary → C). Only these trusted tools are ever run; user binaries are only
//! handed to them as input files and never executed.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::ipc::Request;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::files::{header, raw_body};
use crate::settings::{self, Settings};

const EXE: &str = if cfg!(windows) { ".exe" } else { "" };
const DECOMPILE_SCRIPT: &str = include_str!("../scripts/DecompileAll.java");

// ---------------------------------------------------------------- process helpers

/// Temp dir without a leading '.' (Ghidra rejects project paths containing dot-prefixed elements).
fn tmpdir() -> Result<tempfile::TempDir, String> {
    tempfile::Builder::new().prefix("binary-editor-").tempdir().map_err(|e| e.to_string())
}

struct Output {
    status: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
}

async fn run(mut cmd: Command, stdin: Option<&[u8]>, timeout: Duration) -> Result<Output, String> {
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let program = format!("{:?}", cmd.as_std().get_program());
    let mut child = cmd.spawn().map_err(|e| format!("failed to start {program}: {e}"))?;
    if let (Some(data), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(data).await.map_err(|e| e.to_string())?;
        drop(pipe);
    }
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(o)) => Ok(Output {
            status: o.status.code(),
            stdout: o.stdout,
            stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        }),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(format!("{program} timed out after {}s", timeout.as_secs())),
    }
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    // GUI apps on macOS get a minimal PATH; add the usual install locations.
    for d in ["/opt/homebrew/bin", "/opt/homebrew/opt/rustup/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(PathBuf::from(d));
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        dirs.push(PathBuf::from(home).join(".cargo").join("bin"));
    }
    dirs
}

fn find_on_path(names: &[&str]) -> Option<PathBuf> {
    let dirs = search_dirs();
    names.iter().find_map(|n| {
        dirs.iter().map(|d| d.join(format!("{n}{EXE}"))).find(|p| p.is_file())
    })
}

fn resolve(configured: &str, names: &[&str]) -> Option<PathBuf> {
    if !configured.trim().is_empty() {
        let p = PathBuf::from(configured.trim());
        return p.is_file().then_some(p);
    }
    find_on_path(names)
}

fn clang_path(s: &Settings) -> Option<PathBuf> {
    resolve(&s.clang, &["clang"])
}
fn rustc_path(s: &Settings) -> Option<PathBuf> {
    resolve(&s.rustc, &["rustc"])
}
fn python_path(s: &Settings) -> Option<PathBuf> {
    resolve(&s.python, &["python3", "python"])
}

fn analyze_headless(s: &Settings) -> Option<PathBuf> {
    let script = if cfg!(windows) { "analyzeHeadless.bat" } else { "analyzeHeadless" };
    let mut roots: Vec<PathBuf> = Vec::new();
    if !s.ghidra_dir.trim().is_empty() {
        roots.push(PathBuf::from(s.ghidra_dir.trim()));
    }
    if let Some(d) = std::env::var_os("GHIDRA_INSTALL_DIR") {
        roots.push(PathBuf::from(d));
    }
    roots.push("/opt/homebrew/opt/ghidra/libexec".into());
    roots.push("/usr/local/opt/ghidra/libexec".into());
    roots.push("/usr/share/ghidra".into());
    for parent in ["/opt", "/Applications", "C:\\", "C:\\Program Files"] {
        if let Ok(rd) = std::fs::read_dir(parent) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().to_lowercase().starts_with("ghidra") {
                    roots.push(e.path());
                }
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        if let Ok(rd) = std::fs::read_dir(&home) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().to_lowercase().starts_with("ghidra") {
                    roots.push(e.path());
                }
            }
        }
    }
    roots.into_iter().map(|r| r.join("support").join(script)).find(|p| p.is_file())
}

fn java_home(s: &Settings) -> Option<PathBuf> {
    if !s.java_home.trim().is_empty() {
        return Some(PathBuf::from(s.java_home.trim()));
    }
    if let Some(j) = std::env::var_os("JAVA_HOME") {
        return Some(PathBuf::from(j));
    }
    for v in ["openjdk@25", "openjdk@21", "openjdk"] {
        for prefix in ["/opt/homebrew/opt", "/usr/local/opt"] {
            let p = PathBuf::from(format!("{prefix}/{v}/libexec/openjdk.jdk/Contents/Home"));
            if p.join("bin").join("java").is_file() {
                return Some(p);
            }
        }
    }
    if cfg!(target_os = "macos") {
        let out = std::process::Command::new("/usr/libexec/java_home").output().ok()?;
        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    None
}

async fn version_of(path: &Path, arg: &str) -> String {
    let mut c = Command::new(path);
    c.arg(arg);
    match run(c, None, Duration::from_secs(10)).await {
        Ok(o) => {
            let text = if o.stdout.is_empty() { o.stderr } else { String::from_utf8_lossy(&o.stdout).into_owned() };
            text.lines().next().unwrap_or("").trim().to_string()
        }
        Err(e) => e,
    }
}

// ---------------------------------------------------------------- detect

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    path: Option<String>,
    version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    clang: ToolInfo,
    rustc: ToolInfo,
    python: ToolInfo,
    ghidra: ToolInfo,
    java_home: Option<String>,
}

async fn info(path: Option<PathBuf>, arg: &str) -> ToolInfo {
    match path {
        Some(p) => ToolInfo { version: Some(version_of(&p, arg).await), path: Some(p.display().to_string()) },
        None => ToolInfo { path: None, version: None },
    }
}

#[tauri::command]
pub async fn detect_tools(app: AppHandle) -> Tools {
    let s = settings::load(&app);
    let ghidra = analyze_headless(&s);
    Tools {
        clang: info(clang_path(&s), "--version").await,
        rustc: info(rustc_path(&s), "--version").await,
        python: info(python_path(&s), "--version").await,
        ghidra: ToolInfo {
            version: ghidra.as_ref().and_then(|p| ghidra_version(p)),
            path: ghidra.map(|p| p.display().to_string()),
        },
        java_home: java_home(&s).map(|p| p.display().to_string()),
    }
}

fn ghidra_version(headless: &Path) -> Option<String> {
    let props = headless.parent()?.parent()?.join("Ghidra").join("application.properties");
    let text = std::fs::read_to_string(props).ok()?;
    text.lines().find_map(|l| l.strip_prefix("application.version=")).map(|v| format!("Ghidra {v}"))
}

// ---------------------------------------------------------------- compile

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileRequest {
    /// "c" | "cpp" | "rust"
    language: String,
    source: String,
    /// "0" | "1" | "2" | "3" | "s"
    opt: String,
    /// "native" | "x86_64-linux" | "aarch64-linux" | "x86_64-windows" | "x86_64-macos" | "arm64-macos" | "wasm32"
    target: String,
    intel: bool,
    /// Also produce an object file.
    object: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    asm: String,
    object: Option<Vec<u8>>,
    diagnostics: String,
    command: String,
}

fn clang_triple(t: &str) -> Option<&'static str> {
    Some(match t {
        "x86_64-linux" => "x86_64-unknown-linux-gnu",
        "aarch64-linux" => "aarch64-unknown-linux-gnu",
        "x86_64-windows" => "x86_64-pc-windows-msvc",
        "x86_64-macos" => "x86_64-apple-macos11",
        "arm64-macos" => "arm64-apple-macos11",
        "wasm32" => "wasm32-unknown-unknown",
        _ => return None,
    })
}

fn rust_triple(t: &str) -> Option<&'static str> {
    Some(match t {
        "x86_64-linux" => "x86_64-unknown-linux-gnu",
        "aarch64-linux" => "aarch64-unknown-linux-gnu",
        "x86_64-windows" => "x86_64-pc-windows-msvc",
        "x86_64-macos" => "x86_64-apple-darwin",
        "arm64-macos" => "aarch64-apple-darwin",
        "wasm32" => "wasm32-unknown-unknown",
        _ => return None,
    })
}

fn is_x86(target: &str) -> bool {
    target.starts_with("x86_64") || (target == "native" && cfg!(target_arch = "x86_64"))
}

fn describe(cmd: &Command) -> String {
    let c = cmd.as_std();
    let mut s = Path::new(c.get_program()).file_name().unwrap_or_default().to_string_lossy().into_owned();
    for a in c.get_args() {
        let a = a.to_string_lossy();
        let a = a.rsplit(['/', '\\']).next().unwrap_or(&a).to_string();
        s.push(' ');
        s.push_str(&a);
    }
    s
}

fn build_cmd(req: &CompileRequest, s: &Settings, input: &Path, out: &Path, emit_obj: bool) -> Result<Command, String> {
    let opt = match req.opt.as_str() {
        "0" | "1" | "2" | "3" | "s" => req.opt.as_str(),
        _ => return Err("invalid optimization level".into()),
    };
    match req.language.as_str() {
        "c" | "cpp" => {
            let clang = clang_path(s).ok_or("clang not found — install it or set its path in Settings")?;
            let mut c = Command::new(clang);
            c.arg("-x").arg(if req.language == "c" { "c" } else { "c++" });
            if req.language == "cpp" {
                c.arg("-std=c++20");
            }
            c.arg(format!("-O{opt}"))
                .arg("-fno-asynchronous-unwind-tables")
                .arg(if emit_obj { "-c" } else { "-S" });
            if let Some(t) = clang_triple(&req.target) {
                c.arg("-target").arg(t);
            }
            if req.intel && is_x86(&req.target) && !emit_obj {
                c.arg("-masm=intel");
            }
            c.arg("-o").arg(out).arg(input);
            Ok(c)
        }
        "rust" => {
            let rustc = rustc_path(s).ok_or("rustc not found — install Rust (rustup) or set its path in Settings")?;
            let mut c = Command::new(rustc);
            c.args(["--edition", "2021", "--crate-type", "lib", "--crate-name", "input"])
                .arg("-C")
                .arg(format!("opt-level={opt}"))
                .arg("-C")
                .arg("panic=abort")
                .arg(format!("--emit={}", if emit_obj { "obj" } else { "asm" }));
            if let Some(t) = rust_triple(&req.target) {
                c.arg("--target").arg(t);
            }
            if req.intel && is_x86(&req.target) && !emit_obj {
                c.arg("-C").arg("llvm-args=-x86-asm-syntax=intel");
            }
            c.arg("-o").arg(out).arg(input);
            Ok(c)
        }
        other => Err(format!("unsupported language {other}")),
    }
}

#[tauri::command]
pub async fn compile_source(app: AppHandle, request: CompileRequest) -> Result<CompileResult, String> {
    let s = settings::load(&app);
    let timeout = Duration::from_secs(s.tool_timeout_secs.max(5));
    let dir = tmpdir()?;
    let ext = match request.language.as_str() {
        "c" => "c",
        "cpp" => "cpp",
        _ => "rs",
    };
    let input = dir.path().join(format!("input.{ext}"));
    tokio::fs::write(&input, &request.source).await.map_err(|e| e.to_string())?;

    let asm_out = dir.path().join("out.s");
    let cmd = build_cmd(&request, &s, &input, &asm_out, false)?;
    let command = describe(&cmd);
    let o = run(cmd, None, timeout).await?;
    if o.status != Some(0) {
        return Err(o.stderr);
    }
    let asm = tokio::fs::read_to_string(&asm_out).await.map_err(|e| e.to_string())?;
    let mut diagnostics = o.stderr;

    let object = if request.object {
        let obj_out = dir.path().join("out.o");
        let o = run(build_cmd(&request, &s, &input, &obj_out, true)?, None, timeout).await?;
        if o.status != Some(0) {
            return Err(o.stderr);
        }
        diagnostics.push_str(&o.stderr);
        Some(tokio::fs::read(&obj_out).await.map_err(|e| e.to_string())?)
    } else {
        None
    };
    Ok(CompileResult { asm, object, diagnostics, command })
}

// ---------------------------------------------------------------- python

/// Compiles (never runs) the source, then prints `dis` output and a .pyc image as JSON.
const PY_COMPILE: &str = r#"
import sys, dis, io, json, marshal, importlib.util
name = sys.argv[1]
src = sys.stdin.read()
code = compile(src, name, 'exec')
out = io.StringIO()
dis.dis(code, file=out)
pyc = importlib.util.MAGIC_NUMBER + b'\0' * 12 + marshal.dumps(code)
json.dump({'dis': out.getvalue(), 'pyc': list(pyc), 'version': sys.version.split()[0]}, sys.stdout)
"#;

/// Disassembles a .pyc image. marshal only rebuilds code objects; nothing is executed.
const PY_DIS_PYC: &str = r#"
import sys, dis, marshal, importlib.util
data = sys.stdin.buffer.read()
magic = importlib.util.MAGIC_NUMBER
if data[:4] != magic:
    sys.exit('This .pyc was built by a different Python version (magic %s, this Python %s is %s)'
             % (data[:4].hex(), sys.version.split()[0], magic.hex()))
code = marshal.loads(data[16:])
dis.dis(code)
"#;

#[derive(Serialize)]
pub struct PythonResult {
    dis: String,
    pyc: Vec<u8>,
    version: String,
}

#[derive(Deserialize)]
struct PyOut {
    dis: String,
    pyc: Vec<u8>,
    version: String,
}

#[tauri::command]
pub async fn python_bytecode(app: AppHandle, source: String, filename: String) -> Result<PythonResult, String> {
    let s = settings::load(&app);
    let py = python_path(&s).ok_or("Python not found — install it or set its path in Settings")?;
    let mut c = Command::new(py);
    c.arg("-I").arg("-c").arg(PY_COMPILE).arg(if filename.is_empty() { "<editor>" } else { &filename });
    let o = run(c, Some(source.as_bytes()), Duration::from_secs(s.tool_timeout_secs.max(5))).await?;
    if o.status != Some(0) {
        return Err(o.stderr);
    }
    let r: PyOut = serde_json::from_slice(&o.stdout).map_err(|e| e.to_string())?;
    Ok(PythonResult { dis: r.dis, pyc: r.pyc, version: r.version })
}

#[tauri::command]
pub async fn python_dis_pyc(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let s = settings::load(&app);
    let py = python_path(&s).ok_or("Python not found — install it or set its path in Settings")?;
    let mut c = Command::new(py);
    c.arg("-I").arg("-c").arg(PY_DIS_PYC);
    let o = run(c, Some(raw_body(&request)?), Duration::from_secs(s.tool_timeout_secs.max(5))).await?;
    if o.status != Some(0) {
        return Err(o.stderr);
    }
    Ok(String::from_utf8_lossy(&o.stdout).into_owned())
}

// ---------------------------------------------------------------- ghidra

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecompileResult {
    code: String,
    log: String,
    seconds: f64,
}

fn safe_name(n: &str) -> String {
    let s: String = n
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    let s = s.trim_start_matches('.').to_string();
    if s.is_empty() { "input.bin".into() } else { s }
}

fn tail(s: &str, lines: usize) -> String {
    let v: Vec<&str> = s.lines().collect();
    v[v.len().saturating_sub(lines)..].join("\n")
}

const GHIDRA_MISSING: &str = "Ghidra not found — install it (e.g. `brew install ghidra`) or set its folder in Settings";

#[tauri::command]
pub async fn ghidra_decompile(app: AppHandle, request: Request<'_>) -> Result<DecompileResult, String> {
    let s = settings::load(&app);
    let headless = analyze_headless(&s).ok_or(GHIDRA_MISSING)?;
    let name = safe_name(&header(&request, "x-name").unwrap_or_default());
    let processor = header(&request, "x-processor").unwrap_or_default();
    let max_functions: u32 = header(&request, "x-max").ok().and_then(|m| m.parse().ok()).unwrap_or(2000);
    run_ghidra(&s, &headless, &name, raw_body(&request)?, &processor, max_functions).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecompileFileRequest {
    /// Executable on disk, e.g. one found inside an app bundle.
    path: String,
    /// Architecture to take from a universal binary ("arm64", "x86_64", …); ignored for thin files.
    arch: String,
    processor: String,
    max_functions: u32,
}

/// Decompiles an executable straight from disk (no round trip through the editor buffer).
/// Universal binaries are thinned to one architecture first. The file is never executed.
#[tauri::command]
pub async fn ghidra_decompile_file(app: AppHandle, request: DecompileFileRequest) -> Result<DecompileResult, String> {
    let s = settings::load(&app);
    let headless = analyze_headless(&s).ok_or(GHIDRA_MISSING)?;
    let bytes = tokio::fs::read(&request.path).await.map_err(|e| format!("{}: {e}", request.path))?;
    let (slice, arch) = crate::bundle::thin_slice(&bytes, &request.arch)?;
    let base = Path::new(&request.path).file_name().unwrap_or_default().to_string_lossy().into_owned();
    let name = safe_name(&match arch {
        Some(a) => format!("{base}-{a}"),
        None => base,
    });
    run_ghidra(&s, &headless, &name, slice, &request.processor, request.max_functions.max(1)).await
}

async fn run_ghidra(
    s: &Settings,
    headless: &Path,
    name: &str,
    bytes: &[u8],
    processor: &str,
    max_functions: u32,
) -> Result<DecompileResult, String> {
    let dir = tmpdir()?;
    let input = dir.path().join(name);
    let out = dir.path().join("out.c");
    tokio::fs::write(&input, bytes).await.map_err(|e| e.to_string())?;
    tokio::fs::write(dir.path().join("DecompileAll.java"), DECOMPILE_SCRIPT).await.map_err(|e| e.to_string())?;

    let mut c = Command::new(headless);
    c.arg(dir.path())
        .arg("BinaryEditorProject")
        .arg("-import")
        .arg(&input)
        .arg("-scriptPath")
        .arg(dir.path())
        .arg("-postScript")
        .arg("DecompileAll.java")
        .arg(&out)
        .arg(max_functions.to_string())
        .arg("-deleteProject")
        .arg("-analysisTimeoutPerFile")
        .arg(s.ghidra_timeout_secs.max(30).to_string());
    if !processor.is_empty() {
        c.arg("-processor").arg(processor);
    }
    if let Some(j) = java_home(s) {
        c.env("JAVA_HOME", j);
    }
    let started = Instant::now();
    let o = run(c, None, Duration::from_secs(s.ghidra_timeout_secs.max(30) + 60)).await?;
    let log = format!("{}\n{}", String::from_utf8_lossy(&o.stdout), o.stderr);
    match tokio::fs::read_to_string(&out).await {
        Ok(code) => Ok(DecompileResult { code, log: tail(&log, 200), seconds: started.elapsed().as_secs_f64() }),
        Err(_) => Err(format!("Ghidra produced no output (exit {:?}).\n\n{}", o.status, tail(&log, 60))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_names() {
        assert_eq!(safe_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_name(""), "input.bin");
        assert_eq!(safe_name("a b.exe"), "a_b.exe");
    }

    #[tokio::test]
    async fn clang_emits_assembly() {
        let s = Settings::default();
        if clang_path(&s).is_none() {
            return;
        }
        let dir = tmpdir().unwrap();
        let input = dir.path().join("t.c");
        std::fs::write(&input, "int sq(int x){return x*x;}").unwrap();
        let req = CompileRequest {
            language: "c".into(),
            source: String::new(),
            opt: "2".into(),
            target: "x86_64-linux".into(),
            intel: true,
            object: false,
        };
        let out = dir.path().join("t.s");
        let o = run(build_cmd(&req, &s, &input, &out, false).unwrap(), None, Duration::from_secs(30)).await.unwrap();
        assert_eq!(o.status, Some(0), "{}", o.stderr);
        let asm = std::fs::read_to_string(out).unwrap();
        assert!(asm.contains("imul"), "{asm}");
    }

    /// Slow (JVM + analysis). Run with `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn ghidra_decompiles_object_file() {
        let s = Settings::default();
        let headless = analyze_headless(&s).expect("Ghidra installed");
        let clang = clang_path(&s).expect("clang installed");
        let dir = tmpdir().unwrap();
        std::fs::write(dir.path().join("t.c"), "int square(int x){return x*x;}\n").unwrap();
        let obj = dir.path().join("t.o");
        let st = std::process::Command::new(clang).arg("-c").arg("-O1").arg("-o").arg(&obj).arg(dir.path().join("t.c")).status().unwrap();
        assert!(st.success());
        std::fs::write(dir.path().join("DecompileAll.java"), DECOMPILE_SCRIPT).unwrap();
        let out = dir.path().join("out.c");
        let mut c = Command::new(headless);
        c.arg(dir.path()).arg("P").arg("-import").arg(&obj).arg("-scriptPath").arg(dir.path())
            .arg("-postScript").arg("DecompileAll.java").arg(&out).arg("100").arg("-deleteProject");
        if let Some(j) = java_home(&s) {
            c.env("JAVA_HOME", j);
        }
        let o = run(c, None, Duration::from_secs(600)).await.unwrap();
        let code = std::fs::read_to_string(&out).unwrap_or_else(|_| panic!("no output:\n{}\n{}", String::from_utf8_lossy(&o.stdout), o.stderr));
        assert!(code.contains("param_1 * param_1"), "{code}");
    }

    /// Universal (arm64 + x86_64) object → one slice → Ghidra. Slow; run with `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn ghidra_decompiles_one_slice_of_universal_binary() {
        let s = Settings::default();
        let headless = analyze_headless(&s).expect("Ghidra installed");
        let clang = clang_path(&s).expect("clang installed");
        let dir = tmpdir().unwrap();
        std::fs::write(dir.path().join("t.c"), "int cube(int x){return x*x*x;}\n").unwrap();
        let obj = dir.path().join("t.o");
        let st = std::process::Command::new(clang)
            .args(["-c", "-O1", "-arch", "x86_64", "-arch", "arm64", "-o"])
            .arg(&obj)
            .arg(dir.path().join("t.c"))
            .status()
            .unwrap();
        assert!(st.success());
        let bytes = std::fs::read(&obj).unwrap();
        let (slice, arch) = crate::bundle::thin_slice(&bytes, "x86_64").unwrap();
        assert_eq!(arch.as_deref(), Some("x86_64"));
        let r = run_ghidra(&s, &headless, "t.o-x86_64", slice, "", 100).await.unwrap();
        assert!(r.code.contains("x86:LE:64"), "{}", r.code);
        assert!(r.code.contains("cube"), "{}", r.code);
    }

    /// Real app bundle → main executable → host slice → Ghidra (macOS only). Run with `--ignored`.
    #[tokio::test]
    #[ignore]
    async fn ghidra_decompiles_main_executable_of_textedit() {
        let app = Path::new("/System/Applications/TextEdit.app");
        if !app.is_dir() {
            return;
        }
        let s = Settings::default();
        let headless = analyze_headless(&s).expect("Ghidra installed");
        let info = serde_json::to_value(crate::bundle::inspect(app).unwrap()).unwrap();
        let main = &info["executables"][0];
        assert_eq!(main["kind"], "main");
        let bytes = std::fs::read(main["path"].as_str().unwrap()).unwrap();
        let (slice, arch) = crate::bundle::thin_slice(&bytes, crate::bundle::host_arch()).unwrap();
        let name = safe_name(&format!("TextEdit-{}", arch.unwrap_or_default()));
        let r = run_ghidra(&s, &headless, &name, slice, "", 20).await.unwrap();
        assert!(r.code.contains("// ---- "), "{}\n{}", r.code, r.log);
    }

    #[tokio::test]
    async fn python_compiles_without_running() {
        let Some(py) = python_path(&Settings::default()) else { return };
        let mut c = Command::new(py);
        c.arg("-I").arg("-c").arg(PY_COMPILE).arg("t.py");
        // Would raise if executed; compile() must not run it.
        let o = run(c, Some(b"raise SystemExit(7)\nx = 1 + 2\n"), Duration::from_secs(30)).await.unwrap();
        assert_eq!(o.status, Some(0), "{}", o.stderr);
        let r: PyOut = serde_json::from_slice(&o.stdout).unwrap();
        assert!(r.dis.contains("RAISE") || r.dis.contains("SystemExit"));
        assert!(r.pyc.len() > 16);
    }
}
