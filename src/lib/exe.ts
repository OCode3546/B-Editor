/**
 * Read-only executable parser (ELF / PE / Mach-O, incl. fat Mach-O).
 * Never executes anything — only reads headers and section tables.
 */

export type CsTarget =
  | 'x86-16'
  | 'x86-32'
  | 'x86-64'
  | 'arm'
  | 'thumb'
  | 'arm64'
  | 'mips32'
  | 'mips32be'
  | 'mips64'
  | 'mips64be'
  | 'ppc32be'
  | 'ppc64'
  | 'ppc64be'
  | 'sparc'

export interface Section {
  name: string
  addr: bigint
  offset: number
  size: number
  exec: boolean
}

export interface Slice {
  label: string
  offset: number
  size: number
}

export interface ExeSymbol {
  name: string
  addr: bigint
  size: number
  kind: string
}

export interface ExeInfo {
  format: string
  arch: string
  bits: number
  little: boolean
  entry: bigint | null
  fields: [string, string][]
  sections: Section[]
  slices: Slice[]
  target: CsTarget | null
  /** Only filled by the desktop (goblin) parser. */
  symbols?: ExeSymbol[]
  libraries?: string[]
  engine?: 'goblin' | 'builtin'
}

class Reader {
  private v: DataView
  bytes: Uint8Array
  little: boolean
  constructor(bytes: Uint8Array, little = true) {
    this.bytes = bytes
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.little = little
  }
  check(off: number, n: number) {
    if (off < 0 || off + n > this.bytes.length) throw new Error(`Truncated file at 0x${off.toString(16)}`)
  }
  u8(o: number) {
    this.check(o, 1)
    return this.v.getUint8(o)
  }
  u16(o: number) {
    this.check(o, 2)
    return this.v.getUint16(o, this.little)
  }
  u32(o: number) {
    this.check(o, 4)
    return this.v.getUint32(o, this.little)
  }
  u64(o: number) {
    this.check(o, 8)
    return this.v.getBigUint64(o, this.little)
  }
  cstr(o: number, max = 256) {
    let s = ''
    for (let i = o; i < Math.min(o + max, this.bytes.length) && this.bytes[i]; i++) {
      s += String.fromCharCode(this.bytes[i])
    }
    return s
  }
}

export const hex = (n: number | bigint) => '0x' + n.toString(16)
const toNum = (n: bigint) => {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Value too large')
  return Number(n)
}

export function detectFormat(b: Uint8Array): ExeInfo['format'] | null {
  if (b.length < 4) return null
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return 'ELF'
  if (b[0] === 0x4d && b[1] === 0x5a) return 'PE'
  const m = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(m)) return 'Mach-O'
  if (m === 0xcafebabe && b.length >= 8) {
    const n = ((b[4] << 24) | (b[5] << 16) | (b[6] << 8) | b[7]) >>> 0
    if (n > 0 && n < 32) return 'Mach-O (fat)' // larger values = Java class file
  }
  return null
}

export function parseExecutable(bytes: Uint8Array): ExeInfo {
  switch (detectFormat(bytes)) {
    case 'ELF':
      return parseElf(bytes)
    case 'PE':
      return parsePe(bytes)
    case 'Mach-O':
      return parseMachO(bytes)
    case 'Mach-O (fat)':
      return parseFat(bytes)
    default:
      throw new Error('Not an ELF, PE or Mach-O file')
  }
}

// ---------- ELF ----------

const ELF_MACHINE: Record<number, string> = {
  3: 'x86',
  8: 'MIPS',
  20: 'PowerPC',
  21: 'PowerPC64',
  40: 'ARM',
  62: 'x86-64',
  183: 'AArch64',
  243: 'RISC-V',
  2: 'SPARC',
  43: 'SPARC V9',
}
const ELF_TYPE: Record<number, string> = { 1: 'REL', 2: 'EXEC', 3: 'DYN', 4: 'CORE' }

function elfTarget(machine: number, bits: number, little: boolean): CsTarget | null {
  switch (machine) {
    case 3:
      return 'x86-32'
    case 62:
      return 'x86-64'
    case 40:
      return 'arm'
    case 183:
      return 'arm64'
    case 8:
      return bits === 64 ? (little ? 'mips64' : 'mips64be') : little ? 'mips32' : 'mips32be'
    case 20:
      return 'ppc32be'
    case 21:
      return little ? 'ppc64' : 'ppc64be'
    case 2:
    case 43:
      return 'sparc'
    default:
      return null
  }
}

function parseElf(bytes: Uint8Array): ExeInfo {
  const bits = bytes[4] === 2 ? 64 : 32
  const little = bytes[5] !== 2
  const r = new Reader(bytes, little)
  const is64 = bits === 64
  const type = r.u16(16)
  const machine = r.u16(18)
  const entry = is64 ? r.u64(24) : BigInt(r.u32(24))
  const phoff = is64 ? toNum(r.u64(32)) : r.u32(28)
  const shoff = is64 ? toNum(r.u64(40)) : r.u32(32)
  const phnum = r.u16(is64 ? 56 : 44)
  const shentsize = r.u16(is64 ? 58 : 46)
  const shnum = r.u16(is64 ? 60 : 48)
  const shstrndx = r.u16(is64 ? 62 : 50)

  const sections: Section[] = []
  if (shoff && shnum) {
    const sh = (i: number) => shoff + i * shentsize
    const strOff = shstrndx < shnum ? (is64 ? toNum(r.u64(sh(shstrndx) + 24)) : r.u32(sh(shstrndx) + 16)) : 0
    for (let i = 0; i < shnum; i++) {
      const o = sh(i)
      const nameOff = r.u32(o)
      const shType = r.u32(o + 4)
      const flags = is64 ? r.u64(o + 8) : BigInt(r.u32(o + 8))
      const addr = is64 ? r.u64(o + 16) : BigInt(r.u32(o + 12))
      const offset = is64 ? toNum(r.u64(o + 24)) : r.u32(o + 16)
      const size = is64 ? toNum(r.u64(o + 32)) : r.u32(o + 20)
      if (i === 0 && shType === 0) continue
      sections.push({
        name: strOff ? r.cstr(strOff + nameOff) : `#${i}`,
        addr,
        offset,
        size: shType === 8 ? 0 : size, // SHT_NOBITS (.bss) has no file data
        exec: (flags & 4n) !== 0n,
      })
    }
  }

  return {
    format: 'ELF',
    arch: ELF_MACHINE[machine] ?? `machine ${machine}`,
    bits,
    little,
    entry,
    fields: [
      ['Class', `ELF${bits}`],
      ['Endianness', little ? 'little' : 'big'],
      ['Type', ELF_TYPE[type] ?? String(type)],
      ['Machine', ELF_MACHINE[machine] ?? String(machine)],
      ['Entry', hex(entry)],
      ['Program headers', `${phnum} @ ${hex(phoff)}`],
      ['Section headers', `${shnum} @ ${hex(shoff)}`],
    ],
    sections,
    slices: [],
    target: elfTarget(machine, bits, little),
  }
}

// ---------- PE ----------

const PE_MACHINE: Record<number, [string, CsTarget | null]> = {
  0x14c: ['i386', 'x86-32'],
  0x8664: ['AMD64', 'x86-64'],
  0xaa64: ['ARM64', 'arm64'],
  0x1c0: ['ARM', 'arm'],
  0x1c4: ['ARMv7 Thumb', 'thumb'],
}

function parsePe(bytes: Uint8Array): ExeInfo {
  const r = new Reader(bytes, true)
  const peOff = r.u32(0x3c)
  if (r.u32(peOff) !== 0x00004550) throw new Error('MZ file without PE signature (DOS executable?)')
  const coff = peOff + 4
  const machine = r.u16(coff)
  const nsec = r.u16(coff + 2)
  const timestamp = r.u32(coff + 4)
  const optSize = r.u16(coff + 16)
  const chars = r.u16(coff + 18)
  const opt = coff + 20
  const magic = optSize ? r.u16(opt) : 0
  const is64 = magic === 0x20b
  const entryRva = optSize ? r.u32(opt + 16) : 0
  const imageBase = optSize ? (is64 ? r.u64(opt + 24) : BigInt(r.u32(opt + 28))) : 0n
  const subsystem = optSize ? r.u16(opt + 68) : 0

  const sections: Section[] = []
  const secTable = opt + optSize
  for (let i = 0; i < nsec; i++) {
    const o = secTable + i * 40
    const vsize = r.u32(o + 8)
    const rva = r.u32(o + 12)
    const rawSize = r.u32(o + 16)
    const rawPtr = r.u32(o + 20)
    const ch = r.u32(o + 36)
    sections.push({
      name: r.cstr(o, 8),
      addr: imageBase + BigInt(rva),
      offset: rawPtr,
      size: Math.min(rawSize, vsize || rawSize),
      exec: (ch & 0x20000000) !== 0 || (ch & 0x20) !== 0,
    })
  }
  const [archName, target] = PE_MACHINE[machine] ?? [`machine ${hex(machine)}`, null]
  return {
    format: 'PE',
    arch: archName,
    bits: is64 ? 64 : 32,
    little: true,
    entry: entryRva ? imageBase + BigInt(entryRva) : null,
    fields: [
      ['Format', is64 ? 'PE32+' : 'PE32'],
      ['Machine', archName],
      ['Characteristics', `${hex(chars)}${chars & 0x2000 ? ' (DLL)' : ''}`],
      ['Timestamp', new Date(timestamp * 1000).toISOString()],
      ['Image base', hex(imageBase)],
      ['Entry RVA', hex(entryRva)],
      ['Subsystem', String(subsystem)],
      ['Sections', String(nsec)],
    ],
    sections,
    slices: [],
    target,
  }
}

// ---------- Mach-O ----------

const CPU: Record<number, [string, CsTarget | null]> = {
  7: ['i386', 'x86-32'],
  0x01000007: ['x86_64', 'x86-64'],
  12: ['ARM', 'arm'],
  0x0100000c: ['ARM64', 'arm64'],
  0x0200000c: ['ARM64_32', 'arm64'],
  18: ['PowerPC', 'ppc32be'],
  0x01000012: ['PowerPC64', 'ppc64be'],
}
const MACHO_FILETYPE: Record<number, string> = {
  1: 'OBJECT',
  2: 'EXECUTE',
  6: 'DYLIB',
  7: 'DYLINKER',
  8: 'BUNDLE',
  10: 'DSYM',
}

function parseMachO(bytes: Uint8Array): ExeInfo {
  const little = bytes[0] === 0xce || bytes[0] === 0xcf
  const r = new Reader(bytes, little)
  const magic = r.u32(0)
  const is64 = magic === 0xfeedfacf
  const cputype = r.u32(4)
  const filetype = r.u32(12)
  const ncmds = r.u32(16)
  let off = is64 ? 32 : 28
  const sections: Section[] = []
  let entry: bigint | null = null
  let textVmaddr = 0n
  const loadCmds: string[] = []

  for (let i = 0; i < ncmds; i++) {
    const cmd = r.u32(off)
    const size = r.u32(off + 4)
    if (size < 8) throw new Error('Corrupt load command')
    if (cmd === 0x19 || cmd === 0x1) {
      const seg64 = cmd === 0x19
      const segname = r.cstr(off + 8, 16)
      const vmaddr = seg64 ? r.u64(off + 24) : BigInt(r.u32(off + 24))
      if (segname === '__TEXT') textVmaddr = vmaddr
      const nsects = r.u32(off + (seg64 ? 64 : 48))
      let s = off + (seg64 ? 72 : 56)
      for (let j = 0; j < nsects; j++) {
        const sectname = r.cstr(s, 16)
        const seg = r.cstr(s + 16, 16)
        const addr = seg64 ? r.u64(s + 32) : BigInt(r.u32(s + 32))
        const sz = seg64 ? toNum(r.u64(s + 40)) : r.u32(s + 36)
        const fileOff = r.u32(s + (seg64 ? 48 : 40))
        const flags = r.u32(s + (seg64 ? 64 : 56))
        const type = flags & 0xff
        sections.push({
          name: `${seg},${sectname}`,
          addr,
          offset: fileOff,
          size: type === 1 || type === 0xc ? 0 : sz, // zerofill
          exec: (flags & 0x80000400) !== 0,
        })
        s += seg64 ? 80 : 68
      }
      loadCmds.push(`SEGMENT ${segname}`)
    } else if (cmd === 0x80000028) {
      entry = r.u64(off + 8)
      loadCmds.push('MAIN')
    } else {
      loadCmds.push(hex(cmd))
    }
    off += size
  }
  if (entry !== null) entry += textVmaddr
  const [archName, target] = CPU[cputype] ?? [`cpu ${hex(cputype)}`, null]
  return {
    format: 'Mach-O',
    arch: archName,
    bits: is64 ? 64 : 32,
    little,
    entry,
    fields: [
      ['Magic', hex(magic)],
      ['CPU', archName],
      ['File type', MACHO_FILETYPE[filetype] ?? String(filetype)],
      ['Load commands', String(ncmds)],
      ['Entry', entry === null ? '—' : hex(entry)],
    ],
    sections,
    slices: [],
    target,
  }
}

function parseFat(bytes: Uint8Array): ExeInfo {
  const r = new Reader(bytes, false)
  const n = r.u32(4)
  const slices: Slice[] = []
  for (let i = 0; i < n; i++) {
    const o = 8 + i * 20
    const cpu = r.u32(o)
    slices.push({ label: CPU[cpu]?.[0] ?? hex(cpu), offset: r.u32(o + 8), size: r.u32(o + 12) })
  }
  return {
    format: 'Mach-O (fat)',
    arch: slices.map((s) => s.label).join(', '),
    bits: 64,
    little: false,
    entry: null,
    fields: [['Architectures', String(n)]],
    sections: [],
    slices,
    target: null,
  }
}
