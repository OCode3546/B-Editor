import { Capstone, Const, loadCapstone } from 'capstone-wasm'
import type { CsTarget } from './exe'

export interface Instruction {
  address: bigint
  bytes: Uint8Array
  mnemonic: string
  opStr: string
}

export const CS_TARGETS: { id: CsTarget; label: string }[] = [
  { id: 'x86-64', label: 'x86-64' },
  { id: 'x86-32', label: 'x86 (32-bit)' },
  { id: 'x86-16', label: 'x86 (16-bit)' },
  { id: 'arm64', label: 'ARM64 / AArch64' },
  { id: 'arm', label: 'ARM (A32)' },
  { id: 'thumb', label: 'ARM Thumb' },
  { id: 'mips32', label: 'MIPS32 LE' },
  { id: 'mips32be', label: 'MIPS32 BE' },
  { id: 'mips64', label: 'MIPS64 LE' },
  { id: 'mips64be', label: 'MIPS64 BE' },
  { id: 'ppc32be', label: 'PowerPC 32 BE' },
  { id: 'ppc64', label: 'PowerPC 64 LE' },
  { id: 'ppc64be', label: 'PowerPC 64 BE' },
  { id: 'sparc', label: 'SPARC' },
]

function archMode(t: CsTarget): [number, number] {
  const C = Const
  switch (t) {
    case 'x86-16':
      return [C.CS_ARCH_X86, C.CS_MODE_16]
    case 'x86-32':
      return [C.CS_ARCH_X86, C.CS_MODE_32]
    case 'x86-64':
      return [C.CS_ARCH_X86, C.CS_MODE_64]
    case 'arm':
      return [C.CS_ARCH_ARM, C.CS_MODE_ARM]
    case 'thumb':
      return [C.CS_ARCH_ARM, C.CS_MODE_THUMB]
    case 'arm64':
      return [C.CS_ARCH_ARM64, C.CS_MODE_LITTLE_ENDIAN]
    case 'mips32':
      return [C.CS_ARCH_MIPS, C.CS_MODE_MIPS32]
    case 'mips32be':
      return [C.CS_ARCH_MIPS, C.CS_MODE_MIPS32 | C.CS_MODE_BIG_ENDIAN]
    case 'mips64':
      return [C.CS_ARCH_MIPS, C.CS_MODE_MIPS64]
    case 'mips64be':
      return [C.CS_ARCH_MIPS, C.CS_MODE_MIPS64 | C.CS_MODE_BIG_ENDIAN]
    case 'ppc32be':
      return [C.CS_ARCH_PPC, C.CS_MODE_32 | C.CS_MODE_BIG_ENDIAN]
    case 'ppc64':
      return [C.CS_ARCH_PPC, C.CS_MODE_64]
    case 'ppc64be':
      return [C.CS_ARCH_PPC, C.CS_MODE_64 | C.CS_MODE_BIG_ENDIAN]
    case 'sparc':
      return [C.CS_ARCH_SPARC, C.CS_MODE_BIG_ENDIAN]
  }
}

let capstoneReady: Promise<void> | null = null

export async function disassemble(
  code: Uint8Array,
  target: CsTarget,
  address: bigint,
  opts: { att?: boolean; max?: number } = {},
): Promise<Instruction[]> {
  capstoneReady ??= loadCapstone()
  await capstoneReady
  const [arch, mode] = archMode(target)
  const cs = new Capstone(arch, mode)
  try {
    if (opts.att && target.startsWith('x86')) {
      cs.setOption(Const.CS_OPT_SYNTAX, Const.CS_OPT_SYNTAX_ATT)
    }
    const max = opts.max ?? 50_000
    const unit = target.startsWith('x86') ? 1 : target === 'thumb' ? 2 : 4
    const out: Instruction[] = []
    let pos = 0
    while (pos < code.length && out.length < max) {
      let insns: ReturnType<Capstone['disasm']> = []
      try {
        insns = cs.disasm(code.subarray(pos), { address: address + BigInt(pos), count: max - out.length })
      } catch {
        // capstone-wasm throws when the very first instruction is undecodable
      }
      for (const i of insns) {
        out.push({ address: BigInt(i.address), bytes: i.bytes, mnemonic: i.mnemonic, opStr: i.opStr })
        pos += i.size
      }
      // Capstone stops at undecodable bytes: emit them as data and continue.
      if (pos < code.length && out.length < max) {
        const bad = code.slice(pos, Math.min(pos + unit, code.length))
        out.push({
          address: address + BigInt(pos),
          bytes: bad,
          mnemonic: '.byte',
          opStr: Array.from(bad, (b) => '0x' + b.toString(16).padStart(2, '0')).join(', '),
        })
        pos += bad.length
      }
    }
    return out
  } finally {
    cs.close()
  }
}

// ---------- WASM <-> WAT (wabt) ----------

type WabtInit = typeof import('wabt')
type Wabt = Awaited<ReturnType<WabtInit>>
let wabtReady: Promise<Wabt> | null = null
const getWabt = () =>
  (wabtReady ??= import('wabt').then((m) => {
    const mod = m as unknown as WabtInit & { default?: WabtInit }
    return (mod.default ?? mod)()
  }))

const FEATURES = {
  mutable_globals: true,
  sat_float_to_int: true,
  sign_extension: true,
  multi_value: true,
  bulk_memory: true,
  reference_types: true,
  simd: true,
}

export async function watToWasm(wat: string): Promise<Uint8Array> {
  const wabt = await getWabt()
  const mod = wabt.parseWat('input.wat', wat, FEATURES)
  try {
    mod.resolveNames()
    mod.validate()
    return mod.toBinary({ log: false, write_debug_names: true }).buffer
  } finally {
    mod.destroy()
  }
}

export async function wasmToWat(wasm: Uint8Array): Promise<string> {
  const wabt = await getWabt()
  const mod = wabt.readWasm(wasm, { readDebugNames: true, ...FEATURES })
  try {
    mod.generateNames()
    mod.applyNames()
    return mod.toText({ foldExprs: false, inlineExport: true })
  } finally {
    mod.destroy()
  }
}

export const isWasm = (b: Uint8Array) =>
  b.length >= 8 && b[0] === 0 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d
