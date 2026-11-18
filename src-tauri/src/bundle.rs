//! App bundle inspection (.app / .appex / .framework / .xpc / .bundle). Read-only: walks the
//! bundle, reads Info.plist and the first bytes of candidate files to spot Mach-O executables.
//! Nothing inside the bundle is ever executed.

use serde::Serialize;
use std::collections::BTreeSet;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_FILES: u64 = 100_000;
const MAX_DEPTH: usize = 32;
const MAX_INFO_KEYS: usize = 200;
const HEADER_BYTES: usize = 4096;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BundleExecutable {
    /// Absolute path.
    path: String,
    /// Path relative to the bundle root.
    rel: String,
    /// "main" | "helper" | "helper app" | "framework" | "extension" | "xpc" | "library" | "other"
    kind: &'static str,
    size: u64,
    archs: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BundleInfo {
    path: String,
    name: String,
    identifier: Option<String>,
    version: Option<String>,
    build: Option<String>,
    min_os: Option<String>,
    executable: Option<String>,
    /// Top-level Info.plist keys (scalars shown as-is, arrays / dicts summarized).
    info: Vec<(String, String)>,
    executables: Vec<BundleExecutable>,
    frameworks: Vec<String>,
    /// Technologies recognised from frameworks and resources.
    tech: Vec<String>,
    /// (category, file count)
    resources: Vec<(String, u64)>,
    files: u64,
    total_size: u64,
    /// The walk stopped early (too many files).
    truncated: bool,
}

#[tauri::command]
pub async fn inspect_bundle(path: String) -> Result<BundleInfo, String> {
    tokio::task::spawn_blocking(move || inspect(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

pub fn inspect(root: &Path) -> Result<BundleInfo, String> {
    let meta = std::fs::metadata(root).map_err(|e| format!("{}: {e}", root.display()))?;
    if !meta.is_dir() {
        return Err(format!("{} is not an app bundle (expected a folder such as Name.app)", root.display()));
    }
    // macOS bundles keep everything under Contents/; iOS-style bundles are flat.
    let contents = if root.join("Contents").is_dir() { root.join("Contents") } else { root.to_path_buf() };
    let plist_path = contents.join("Info.plist");
    let dict = plist::Value::from_file(&plist_path)
        .ok()
        .and_then(|v| v.into_dictionary())
        .ok_or_else(|| format!("{} has no readable Info.plist — is it an app bundle?", root.display()))?;
    let get = |k: &str| dict.get(k).and_then(|v| v.as_string()).map(str::to_string);

    let executable = get("CFBundleExecutable");
    let main_rel: Option<PathBuf> = executable.as_ref().map(|e| {
        let dir = if contents != root { Path::new("Contents").join("MacOS") } else { PathBuf::new() };
        dir.join(e)
    });

    let mut info: Vec<(String, String)> = dict
        .iter()
        .take(MAX_INFO_KEYS)
        .map(|(k, v)| (k.clone(), summarize(v)))
        .collect();
    info.sort();

    let mut w = Walk::default();
    w.walk(root, root, 0);

    let mut executables: Vec<BundleExecutable> = w
        .executables
        .into_iter()
        .map(|(p, size, archs)| {
            let rel = p.strip_prefix(root).unwrap_or(&p).to_path_buf();
            let kind = classify(&rel, main_rel.as_deref());
            BundleExecutable {
                path: p.display().to_string(),
                rel: rel.display().to_string(),
                kind,
                size,
                archs,
            }
        })
        .collect();
    executables.sort_by(|a, b| kind_rank(a.kind).cmp(&kind_rank(b.kind)).then_with(|| a.rel.cmp(&b.rel)));

    let frameworks: Vec<String> = w.frameworks.into_iter().collect();
    let tech = detect_tech(&frameworks, &w.markers);
    let resources = CATEGORIES
        .iter()
        .zip(w.counts.iter())
        .filter(|(_, n)| **n > 0)
        .map(|((label, _), n)| (label.to_string(), *n))
        .collect();

    Ok(BundleInfo {
        path: root.display().to_string(),
        name: get("CFBundleDisplayName")
            .or_else(|| get("CFBundleName"))
            .unwrap_or_else(|| root.file_stem().unwrap_or_default().to_string_lossy().into_owned()),
        identifier: get("CFBundleIdentifier"),
        version: get("CFBundleShortVersionString"),
        build: get("CFBundleVersion"),
        min_os: get("LSMinimumSystemVersion").or_else(|| get("MinimumOSVersion")),
        executable,
        info,
        executables,
        frameworks,
        tech,
        resources,
        files: w.files,
        total_size: w.total_size,
        truncated: w.truncated,
    })
}

fn summarize(v: &plist::Value) -> String {
    use plist::Value::*;
    match v {
        String(s) => s.clone(),
        Boolean(b) => b.to_string(),
        Integer(i) => i.to_string(),
        Real(r) => r.to_string(),
        Date(d) => format!("{d:?}"),
        Data(d) => format!("<{} bytes>", d.len()),
        Array(a) => format!("[{} items]", a.len()),
        Dictionary(d) => format!("{{{} keys}}", d.len()),
        Uid(u) => format!("uid {}", u.get()),
        _ => "?".into(),
    }
}

// ---------------------------------------------------------------- walk

/// Resource categories: (label, extensions). Directories with these extensions count once.
const CATEGORIES: &[(&str, &[&str])] = &[
    ("Interface (nib / storyboard)", &["nib", "storyboardc", "xib", "storyboard"]),
    ("Images & icons", &["png", "jpg", "jpeg", "gif", "icns", "ico", "tiff", "tif", "pdf", "svg", "heic", "webp"]),
    ("Asset catalogs", &["car"]),
    ("Localizations", &["lproj"]),
    ("Strings", &["strings", "stringsdict", "xcstrings"]),
    ("Scripts & web code", &["js", "mjs", "asar", "html", "css", "py", "pyc", "lua", "rb", "jar", "dll", "wasm"]),
    ("Data & config", &["plist", "json", "xml", "db", "sqlite", "momd", "mom", "yaml", "yml"]),
    ("Fonts", &["ttf", "otf", "ttc", "woff", "woff2"]),
    ("Audio & video", &["mp3", "m4a", "aiff", "aif", "wav", "caf", "mp4", "mov", "m4v"]),
    ("Machine learning models", &["mlmodelc", "mlmodel", "onnx", "tflite"]),
];

#[derive(Default)]
struct Walk {
    files: u64,
    total_size: u64,
    truncated: bool,
    executables: Vec<(PathBuf, u64, Vec<String>)>,
    frameworks: BTreeSet<String>,
    /// Lower-case file / folder names that hint at a technology.
    markers: BTreeSet<String>,
    counts: [u64; CATEGORIES.len()],
}

impl Walk {
    fn walk(&mut self, root: &Path, dir: &Path, depth: usize) {
        if depth > MAX_DEPTH || self.truncated {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            if self.files >= MAX_FILES {
                self.truncated = true;
                return;
            }
            let p = e.path();
            // symlink_metadata: never follow links (frameworks use Versions/Current links).
            let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
            let name = e.file_name().to_string_lossy().into_owned();
            let ext = Path::new(&name).extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if ext == "framework" {
                    self.frameworks.insert(name.trim_end_matches(".framework").to_string());
                }
                self.count(&ext);
                self.mark(&name);
                if p.strip_prefix(root).map(|r| r.starts_with("Contents/_CodeSignature")).unwrap_or(false) {
                    continue;
                }
                self.walk(root, &p, depth + 1);
                continue;
            }
            self.files += 1;
            self.total_size += meta.len();
            self.count(&ext);
            self.mark(&name);
            // Executables either have no extension or are libraries / native modules.
            if ext.is_empty() || matches!(ext.as_str(), "dylib" | "so" | "node" | "bundle") {
                if let Some(archs) = read_header(&p).and_then(|h| macho_archs(&h)) {
                    self.executables.push((p, meta.len(), archs));
                }
            }
        }
    }

    fn count(&mut self, ext: &str) {
        if ext.is_empty() {
            return;
        }
        if let Some(i) = CATEGORIES.iter().position(|(_, exts)| exts.contains(&ext)) {
            self.counts[i] += 1;
        }
    }

    fn mark(&mut self, name: &str) {
        let n = name.to_lowercase();
        const MARKERS: &[&str] = &[
            "app.asar", "libswiftcore.dylib", "libmonosgen-2.0.dylib", "jre", "jdk", "python.framework",
            "main.jsbundle", "assets.car", "default.metallib",
        ];
        if MARKERS.contains(&n.as_str()) || n.ends_with(".storyboardc") || n.ends_with(".nib") {
            self.markers.insert(if n.ends_with(".storyboardc") || n.ends_with(".nib") { "nib".into() } else { n });
        }
    }
}

fn read_header(p: &Path) -> Option<Vec<u8>> {
    let mut f = File::open(p).ok()?;
    let mut buf = vec![0u8; HEADER_BYTES];
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(_) => return None,
        }
    }
    buf.truncate(n);
    Some(buf)
}

fn classify(rel: &Path, main: Option<&Path>) -> &'static str {
    if Some(rel) == main {
        return "main";
    }
    let s = rel.to_string_lossy();
    let ext = rel.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
    if s.contains(".appex/") {
        "extension"
    } else if s.contains(".xpc/") {
        "xpc"
    } else if s.contains(".app/") {
        "helper app"
    } else if s.contains(".framework/") {
        "framework"
    } else if matches!(ext.as_str(), "dylib" | "so" | "node") {
        "library"
    } else if rel.starts_with("Contents/MacOS") {
        "helper"
    } else {
        "other"
    }
}

fn kind_rank(k: &str) -> u8 {
    match k {
        "main" => 0,
        "helper" => 1,
        "helper app" => 2,
        "extension" => 3,
        "xpc" => 4,
        "framework" => 5,
        "library" => 6,
        _ => 7,
    }
}

fn detect_tech(frameworks: &[String], markers: &BTreeSet<String>) -> Vec<String> {
    let has_fw = |n: &str| frameworks.iter().any(|f| f.eq_ignore_ascii_case(n));
    let mut t = Vec::new();
    if has_fw("Electron Framework") || markers.contains("app.asar") {
        t.push("Electron — app logic is JavaScript (resources/app.asar)");
    }
    if has_fw("Chromium Embedded Framework") {
        t.push("Chromium Embedded Framework (CEF)");
    }
    if has_fw("FlutterMacOS") || has_fw("Flutter") {
        t.push("Flutter — app logic is Dart compiled to App.framework");
    }
    if frameworks.iter().any(|f| f.starts_with("Qt")) {
        t.push("Qt (C++)");
    }
    if markers.contains("main.jsbundle") {
        t.push("React Native — app logic is a JavaScript bundle");
    }
    if markers.contains("libmonosgen-2.0.dylib") {
        t.push(".NET / Mono");
    }
    if markers.contains("jre") || markers.contains("jdk") {
        t.push("Java (bundled runtime)");
    }
    if markers.contains("python.framework") || has_fw("Python") {
        t.push("Python (bundled interpreter)");
    }
    if markers.contains("libswiftcore.dylib") {
        t.push("Swift (embedded runtime)");
    }
    if markers.contains("nib") {
        t.push("AppKit / UIKit interface files (nib / storyboard)");
    }
    if markers.contains("assets.car") {
        t.push("Xcode asset catalog");
    }
    if has_fw("Sparkle") {
        t.push("Sparkle auto-updater");
    }
    t.into_iter().map(String::from).collect()
}

// ---------------------------------------------------------------- Mach-O headers

pub fn cpu_name(cpu: u32, sub: u32) -> String {
    match cpu {
        7 => "i386".into(),
        0x0100_0007 if sub & 0xff == 8 => "x86_64h".into(),
        0x0100_0007 => "x86_64".into(),
        12 => "arm".into(),
        0x0100_000c if sub & 0xff == 2 => "arm64e".into(),
        0x0100_000c => "arm64".into(),
        0x0200_000c => "arm64_32".into(),
        18 => "ppc".into(),
        0x0100_0012 => "ppc64".into(),
        _ => format!("cpu {cpu:#x}"),
    }
}

fn be32(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(o..o + 4)?.try_into().ok()?))
}
fn le32(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?))
}
fn be64(b: &[u8], o: usize) -> Option<u64> {
    Some(u64::from_be_bytes(b.get(o..o + 8)?.try_into().ok()?))
}

/// Universal binary slices: (arch label, offset, size). None if not a fat Mach-O.
pub fn fat_arches(b: &[u8]) -> Option<Vec<(String, u64, u64)>> {
    let magic = be32(b, 0)?;
    let wide = match magic {
        0xcafe_babe => false,
        0xcafe_babf => true,
        _ => return None,
    };
    let n = be32(b, 4)? as usize;
    // Java .class files share 0xcafebabe; their "count" is the class version (>= 45).
    if n == 0 || n > 30 {
        return None;
    }
    let entry = if wide { 32 } else { 20 };
    let mut v = Vec::with_capacity(n);
    for i in 0..n {
        let o = 8 + i * entry;
        let (cpu, sub) = (be32(b, o)?, be32(b, o + 4)?);
        let (off, size) = if wide {
            (be64(b, o + 8)?, be64(b, o + 16)?)
        } else {
            (be32(b, o + 8)? as u64, be32(b, o + 12)? as u64)
        };
        v.push((cpu_name(cpu, sub), off, size));
    }
    Some(v)
}

/// Architectures of a Mach-O file from its first bytes. None if it is not Mach-O.
pub fn macho_archs(h: &[u8]) -> Option<Vec<String>> {
    if let Some(f) = fat_arches(h) {
        return Some(f.into_iter().map(|(l, _, _)| l).collect());
    }
    match le32(h, 0)? {
        0xfeed_face | 0xfeed_facf => return Some(vec![cpu_name(le32(h, 4)?, le32(h, 8)?)]),
        _ => {}
    }
    match be32(h, 0)? {
        0xfeed_face | 0xfeed_facf => Some(vec![cpu_name(be32(h, 4)?, be32(h, 8)?)]),
        _ => None,
    }
}

pub fn host_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") { "arm64" } else { "x86_64" }
}

/// Picks one architecture out of a universal binary (`want`, else the host's, else the first).
/// Thin files are returned unchanged with `None` as the label.
pub fn thin_slice<'a>(bytes: &'a [u8], want: &str) -> Result<(&'a [u8], Option<String>), String> {
    let Some(arches) = fat_arches(bytes) else { return Ok((bytes, None)) };
    let pick = arches
        .iter()
        .position(|(l, _, _)| l == want)
        .or_else(|| arches.iter().position(|(l, _, _)| l == host_arch()))
        .unwrap_or(0);
    let (label, off, size) = &arches[pick];
    let start = usize::try_from(*off).map_err(|e| e.to_string())?;
    let end = start.checked_add(usize::try_from(*size).map_err(|e| e.to_string())?).ok_or("bad slice size")?;
    let slice = bytes.get(start..end).ok_or_else(|| format!("{label} slice lies outside the file"))?;
    Ok((slice, Some(label.clone())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thin(cpu: u32) -> Vec<u8> {
        let mut b = vec![0u8; 64];
        b[0..4].copy_from_slice(&0xfeed_facfu32.to_le_bytes());
        b[4..8].copy_from_slice(&cpu.to_le_bytes());
        b
    }

    /// Universal binary with an x86_64 slice at 0x1000 and an arm64 slice at 0x2000.
    fn fat() -> Vec<u8> {
        let mut b = vec![0u8; 0x3000];
        b[0..4].copy_from_slice(&0xcafe_babeu32.to_be_bytes());
        b[4..8].copy_from_slice(&2u32.to_be_bytes());
        for (i, (cpu, off)) in [(0x0100_0007u32, 0x1000u32), (0x0100_000c, 0x2000)].iter().enumerate() {
            let o = 8 + i * 20;
            b[o..o + 4].copy_from_slice(&cpu.to_be_bytes());
            b[o + 8..o + 12].copy_from_slice(&off.to_be_bytes());
            b[o + 12..o + 16].copy_from_slice(&0x1000u32.to_be_bytes());
            let t = thin(*cpu);
            b[*off as usize..*off as usize + t.len()].copy_from_slice(&t);
        }
        b
    }

    #[test]
    fn reads_macho_headers() {
        assert_eq!(macho_archs(&thin(0x0100_000c)), Some(vec!["arm64".into()]));
        assert_eq!(macho_archs(&fat()), Some(vec!["x86_64".into(), "arm64".into()]));
        assert_eq!(macho_archs(b"#!/bin/sh\necho hi\n"), None);
        // Java class file: same magic, version 52 in the "count" field.
        assert_eq!(macho_archs(&[0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52]), None);
    }

    #[test]
    fn extracts_slices() {
        let f = fat();
        let (s, l) = thin_slice(&f, "x86_64").unwrap();
        assert_eq!(l.as_deref(), Some("x86_64"));
        assert_eq!(macho_archs(s), Some(vec!["x86_64".into()]));
        let (s, l) = thin_slice(&f, "arm64").unwrap();
        assert_eq!(l.as_deref(), Some("arm64"));
        assert_eq!(s.len(), 0x1000);
        let t = thin(7);
        assert_eq!(thin_slice(&t, "arm64").unwrap(), (&t[..], None));

        let mut broken = fat();
        broken.truncate(0x2800);
        assert!(thin_slice(&broken, "arm64").is_err());
    }

    #[test]
    fn inspects_a_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Demo.app");
        let c = root.join("Contents");
        for d in ["MacOS", "Resources/en.lproj", "Resources/Base.lproj/Main.storyboardc", "Frameworks/Foo.framework/Versions/A", "PlugIns/Share.appex/Contents/MacOS"] {
            std::fs::create_dir_all(c.join(d)).unwrap();
        }
        std::fs::write(
            c.join("Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Demo</string>
<key>CFBundleIdentifier</key><string>com.example.demo</string>
<key>CFBundleName</key><string>Demo</string>
<key>CFBundleShortVersionString</key><string>1.2</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>CFBundleDocumentTypes</key><array><dict/><dict/></array>
</dict></plist>"#,
        )
        .unwrap();
        std::fs::write(c.join("MacOS/Demo"), thin(0x0100_000c)).unwrap();
        std::fs::write(c.join("MacOS/run.sh"), b"#!/bin/sh\n").unwrap();
        std::fs::write(c.join("Frameworks/Foo.framework/Versions/A/Foo"), fat()).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("A", c.join("Frameworks/Foo.framework/Versions/Current")).unwrap();
        std::fs::write(c.join("PlugIns/Share.appex/Contents/MacOS/Share"), thin(0x0100_000c)).unwrap();
        std::fs::write(c.join("Resources/en.lproj/Localizable.strings"), b"").unwrap();
        std::fs::write(c.join("Resources/AppIcon.icns"), b"icns").unwrap();
        std::fs::write(c.join("Resources/app.asar"), b"asar").unwrap();

        let b = inspect(&root).unwrap();
        assert_eq!(b.identifier.as_deref(), Some("com.example.demo"));
        assert_eq!(b.version.as_deref(), Some("1.2"));
        assert_eq!(b.min_os.as_deref(), Some("13.0"));
        assert!(b.info.contains(&("CFBundleDocumentTypes".into(), "[2 items]".into())));
        let kinds: Vec<(&str, &str)> = b.executables.iter().map(|e| (e.kind, e.rel.as_str())).collect();
        assert_eq!(
            kinds,
            [
                ("main", "Contents/MacOS/Demo"),
                ("extension", "Contents/PlugIns/Share.appex/Contents/MacOS/Share"),
                ("framework", "Contents/Frameworks/Foo.framework/Versions/A/Foo"),
            ]
        );
        assert_eq!(b.executables[2].archs, ["x86_64", "arm64"]);
        assert_eq!(b.frameworks, ["Foo"]);
        assert!(b.tech.iter().any(|t| t.starts_with("Electron")));
        assert!(b.tech.iter().any(|t| t.starts_with("AppKit")));
        assert!(b.resources.contains(&("Localizations".into(), 2)));
        assert!(b.resources.contains(&("Images & icons".into(), 1)));
        assert!(!b.truncated);
    }

    #[test]
    fn rejects_non_bundles() {
        let dir = tempfile::tempdir().unwrap();
        assert!(inspect(dir.path()).unwrap_err().contains("Info.plist"));
        let f = dir.path().join("x");
        std::fs::write(&f, b"x").unwrap();
        assert!(inspect(&f).unwrap_err().contains("not an app bundle"));
    }

    /// Real system app, when present (macOS).
    #[test]
    fn inspects_textedit() {
        let p = Path::new("/System/Applications/TextEdit.app");
        if !p.is_dir() {
            return;
        }
        let b = inspect(p).unwrap();
        assert_eq!(b.identifier.as_deref(), Some("com.apple.TextEdit"));
        assert_eq!(b.executables.first().map(|e| e.kind), Some("main"));
    }
}
