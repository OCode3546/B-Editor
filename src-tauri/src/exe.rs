//! Executable parsing with goblin. Read-only: user binaries are never executed.

use goblin::{elf, mach, pe, Object};
use serde::Serialize;
use tauri::ipc::Request;

use crate::files::raw_body;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    name: String,
    /// u64 as decimal string (JS turns it into a BigInt)
    addr: String,
    offset: u64,
    size: u64,
    exec: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    name: String,
    addr: String,
    size: u64,
    kind: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Slice {
    label: String,
    offset: u64,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExeInfo {
    format: String,
    arch: String,
    bits: u8,
    little: bool,
    entry: Option<String>,
    fields: Vec<(String, String)>,
    sections: Vec<Section>,
    slices: Vec<Slice>,
    symbols: Vec<Symbol>,
    libraries: Vec<String>,
    target: Option<&'static str>,
}

const MAX_SYMBOLS: usize = 20_000;

#[tauri::command]
pub fn parse_executable(request: Request<'_>) -> Result<ExeInfo, String> {
    parse(raw_body(&request)?)
}

pub fn parse(bytes: &[u8]) -> Result<ExeInfo, String> {
    match Object::parse(bytes).map_err(|e| e.to_string())? {
        Object::Elf(e) => Ok(from_elf(&e)),
        Object::PE(p) => Ok(from_pe(&p)),
        Object::Mach(mach::Mach::Binary(m)) => Ok(from_macho(&m)),
        Object::Mach(mach::Mach::Fat(f)) => from_fat(&f),
        Object::Archive(_) => Err("Static library archive (.a) — extract a member first".into()),
        _ => Err("Not an ELF, PE or Mach-O file".into()),
    }
}

fn hex(n: u64) -> String {
    format!("{n:#x}")
}

// ---------------- ELF ----------------

fn elf_arch(m: u16) -> &'static str {
    match m {
        elf::header::EM_386 => "x86",
        elf::header::EM_X86_64 => "x86-64",
        elf::header::EM_ARM => "ARM",
        elf::header::EM_AARCH64 => "AArch64",
        elf::header::EM_MIPS => "MIPS",
        elf::header::EM_PPC => "PowerPC",
        elf::header::EM_PPC64 => "PowerPC64",
        elf::header::EM_RISCV => "RISC-V",
        elf::header::EM_SPARC | elf::header::EM_SPARCV9 => "SPARC",
        _ => "unknown",
    }
}

fn elf_target(m: u16, is64: bool, le: bool) -> Option<&'static str> {
    Some(match m {
        elf::header::EM_386 => "x86-32",
        elf::header::EM_X86_64 => "x86-64",
        elf::header::EM_ARM => "arm",
        elf::header::EM_AARCH64 => "arm64",
        elf::header::EM_MIPS => match (is64, le) {
            (true, true) => "mips64",
            (true, false) => "mips64be",
            (false, true) => "mips32",
            (false, false) => "mips32be",
        },
        elf::header::EM_PPC => "ppc32be",
        elf::header::EM_PPC64 => {
            if le {
                "ppc64"
            } else {
                "ppc64be"
            }
        }
        elf::header::EM_SPARC | elf::header::EM_SPARCV9 => "sparc",
        _ => return None,
    })
}

fn from_elf(e: &elf::Elf) -> ExeInfo {
    let h = &e.header;
    let sections = e
        .section_headers
        .iter()
        .filter(|s| s.sh_type != elf::section_header::SHT_NULL)
        .map(|s| Section {
            name: e.shdr_strtab.get_at(s.sh_name).unwrap_or("?").to_string(),
            addr: s.sh_addr.to_string(),
            offset: s.sh_offset,
            size: if s.sh_type == elf::section_header::SHT_NOBITS { 0 } else { s.sh_size },
            exec: s.sh_flags & u64::from(elf::section_header::SHF_EXECINSTR) != 0,
        })
        .collect();

    let mut symbols: Vec<Symbol> = Vec::new();
    for (syms, strtab) in [(&e.syms, &e.strtab), (&e.dynsyms, &e.dynstrtab)] {
        for s in syms.iter() {
            if s.st_type() != elf::sym::STT_FUNC || s.st_value == 0 {
                continue;
            }
            if let Some(name) = strtab.get_at(s.st_name).filter(|n| !n.is_empty()) {
                symbols.push(Symbol { name: name.into(), addr: s.st_value.to_string(), size: s.st_size, kind: "func" });
            }
        }
    }
    dedup_symbols(&mut symbols);

    let bits = if e.is_64 { 64 } else { 32 };
    ExeInfo {
        format: "ELF".into(),
        arch: elf_arch(h.e_machine).into(),
        bits,
        little: e.little_endian,
        entry: (e.entry != 0).then(|| e.entry.to_string()),
        fields: vec![
            ("Class".into(), format!("ELF{bits}")),
            ("Type".into(), elf::header::et_to_str(h.e_type).into()),
            ("Machine".into(), elf::header::machine_to_str(h.e_machine).into()),
            ("Entry".into(), hex(e.entry)),
            ("Interpreter".into(), e.interpreter.unwrap_or("—").into()),
            ("Shared object".into(), e.soname.unwrap_or("—").into()),
            ("Program headers".into(), e.program_headers.len().to_string()),
            ("Sections".into(), e.section_headers.len().to_string()),
        ],
        sections,
        slices: vec![],
        symbols,
        libraries: e.libraries.iter().map(|s| s.to_string()).collect(),
        target: elf_target(h.e_machine, e.is_64, e.little_endian),
    }
}

// ---------------- PE ----------------

fn from_pe(p: &pe::PE) -> ExeInfo {
    use pe::header::*;
    let machine = p.header.coff_header.machine;
    let (arch, target) = match machine {
        COFF_MACHINE_X86 => ("i386", Some("x86-32")),
        COFF_MACHINE_X86_64 => ("AMD64", Some("x86-64")),
        COFF_MACHINE_ARM64 => ("ARM64", Some("arm64")),
        COFF_MACHINE_ARM => ("ARM", Some("arm")),
        COFF_MACHINE_ARMNT => ("ARMv7 Thumb", Some("thumb")),
        _ => ("unknown", None),
    };
    let base = p.image_base;
    let sections = p
        .sections
        .iter()
        .map(|s| Section {
            name: s.name().unwrap_or("?").to_string(),
            addr: (base + u64::from(s.virtual_address)).to_string(),
            offset: u64::from(s.pointer_to_raw_data),
            size: u64::from(if s.virtual_size > 0 { s.size_of_raw_data.min(s.virtual_size) } else { s.size_of_raw_data }),
            exec: s.characteristics & pe::section_table::IMAGE_SCN_MEM_EXECUTE != 0,
        })
        .collect();
    let mut symbols: Vec<Symbol> = p
        .exports
        .iter()
        .filter_map(|e| {
            Some(Symbol { name: e.name?.to_string(), addr: (base + e.rva as u64).to_string(), size: e.size as u64, kind: "export" })
        })
        .collect();
    dedup_symbols(&mut symbols);
    let mut libraries: Vec<String> = p.libraries.iter().map(|s| s.to_string()).collect();
    libraries.dedup();
    let entry = base + u64::from(p.entry);
    ExeInfo {
        format: "PE".into(),
        arch: arch.into(),
        bits: if p.is_64 { 64 } else { 32 },
        little: true,
        entry: (p.entry != 0).then(|| entry.to_string()),
        fields: vec![
            ("Format".into(), if p.is_64 { "PE32+" } else { "PE32" }.into()),
            ("Machine".into(), format!("{arch} ({machine:#x})")),
            ("Kind".into(), if p.is_lib { "DLL" } else { "EXE" }.into()),
            ("Image base".into(), hex(base)),
            ("Entry".into(), hex(entry)),
            ("Sections".into(), p.sections.len().to_string()),
            ("Imports".into(), p.imports.len().to_string()),
            ("Exports".into(), p.exports.len().to_string()),
        ],
        sections,
        slices: vec![],
        symbols,
        libraries,
        target,
    }
}

// ---------------- Mach-O ----------------

fn cpu(cputype: u32) -> (&'static str, Option<&'static str>) {
    use mach::cputype::*;
    match cputype {
        CPU_TYPE_X86 => ("i386", Some("x86-32")),
        CPU_TYPE_X86_64 => ("x86_64", Some("x86-64")),
        CPU_TYPE_ARM => ("ARM", Some("arm")),
        CPU_TYPE_ARM64 => ("ARM64", Some("arm64")),
        CPU_TYPE_ARM64_32 => ("ARM64_32", Some("arm64")),
        CPU_TYPE_POWERPC => ("PowerPC", Some("ppc32be")),
        CPU_TYPE_POWERPC64 => ("PowerPC64", Some("ppc64be")),
        _ => ("unknown", None),
    }
}

fn from_macho(m: &mach::MachO) -> ExeInfo {
    let mut sections = Vec::new();
    for seg in m.segments.iter() {
        if let Ok(secs) = seg.sections() {
            for (s, _) in secs {
                let ty = s.flags & mach::constants::SECTION_TYPE;
                sections.push(Section {
                    name: format!("{},{}", s.segname().unwrap_or("?"), s.name().unwrap_or("?")),
                    addr: s.addr.to_string(),
                    offset: u64::from(s.offset),
                    size: if ty == mach::constants::S_ZEROFILL || ty == mach::constants::S_GB_ZEROFILL { 0 } else { s.size },
                    exec: s.flags & (mach::constants::S_ATTR_PURE_INSTRUCTIONS | mach::constants::S_ATTR_SOME_INSTRUCTIONS) != 0,
                });
            }
        }
    }
    let mut symbols: Vec<Symbol> = m
        .symbols()
        .filter_map(Result::ok)
        .filter(|(name, n)| !n.is_stab() && n.n_value != 0 && n.get_type() == mach::symbols::N_SECT && !name.is_empty())
        .map(|(name, n)| Symbol { name: name.to_string(), addr: n.n_value.to_string(), size: 0, kind: "func" })
        .collect();
    dedup_symbols(&mut symbols);
    let cputype = m.header.cputype();
    let (arch, target) = cpu(cputype);
    ExeInfo {
        format: "Mach-O".into(),
        arch: arch.into(),
        bits: if m.is_64 { 64 } else { 32 },
        little: m.little_endian,
        entry: (m.entry != 0).then(|| m.entry.to_string()),
        fields: vec![
            ("CPU".into(), format!("{arch} ({cputype:#x})")),
            ("File type".into(), mach::header::filetype_to_str(m.header.filetype).into()),
            ("Load commands".into(), m.load_commands.len().to_string()),
            ("Entry".into(), if m.entry != 0 { hex(m.entry) } else { "—".into() }),
            ("Dylib name".into(), m.name.unwrap_or("—").into()),
            ("Linked dylibs".into(), m.libs.len().to_string()),
        ],
        sections,
        slices: vec![],
        symbols,
        libraries: m.libs.iter().map(|s| s.to_string()).collect(),
        target,
    }
}

fn from_fat(f: &mach::MultiArch) -> Result<ExeInfo, String> {
    let mut slices = Vec::new();
    for a in f.iter_arches() {
        let a = a.map_err(|e| e.to_string())?;
        let (label, _) = cpu(a.cputype);
        slices.push(Slice { label: label.into(), offset: u64::from(a.offset), size: u64::from(a.size) });
    }
    Ok(ExeInfo {
        format: "Mach-O (fat)".into(),
        arch: slices.iter().map(|s| s.label.clone()).collect::<Vec<_>>().join(", "),
        bits: 64,
        little: false,
        entry: None,
        fields: vec![("Architectures".into(), slices.len().to_string())],
        sections: vec![],
        slices,
        symbols: vec![],
        libraries: vec![],
        target: None,
    })
}

fn dedup_symbols(s: &mut Vec<Symbol>) {
    s.sort_by(|a, b| a.addr.parse::<u64>().unwrap_or(0).cmp(&b.addr.parse::<u64>().unwrap_or(0)).then(a.name.cmp(&b.name)));
    s.dedup_by(|a, b| a.addr == b.addr && a.name == b.name);
    s.truncate(MAX_SYMBOLS);
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_garbage() {
        assert!(super::parse(b"hello world").is_err());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn parses_system_binary() {
        let bytes = std::fs::read("/usr/bin/true").unwrap();
        let info = super::parse(&bytes).unwrap();
        assert!(info.format.starts_with("Mach-O"));
        let s = info.slices.first().expect("fat binary");
        let inner = super::parse(&bytes[s.offset as usize..(s.offset + s.size) as usize]).unwrap();
        assert!(inner.sections.iter().any(|x| x.exec));
        assert!(inner.entry.is_some());
    }
}
