/**
 * Bridge to the Tauri backend. Everything here is only usable when `isDesktop` is true;
 * the web build keeps working with the in-browser engines.
 */
import { invoke } from '@tauri-apps/api/core'
import type { ExeInfo } from './lib/exe'

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export interface ToolInfo {
  path: string | null
  version: string | null
}
export interface Tools {
  clang: ToolInfo
  rustc: ToolInfo
  python: ToolInfo
  ghidra: ToolInfo
  javaHome: string | null
}

export interface Settings {
  clang: string
  rustc: string
  python: string
  ghidraDir: string
  javaHome: string
  toolTimeoutSecs: number
  ghidraTimeoutSecs: number
}

export type CompileLanguage = 'c' | 'cpp' | 'rust'
export interface CompileRequest {
  language: CompileLanguage
  source: string
  opt: '0' | '1' | '2' | '3' | 's'
  target: string
  intel: boolean
  object: boolean
}
export interface CompileResult {
  asm: string
  object: number[] | null
  diagnostics: string
  command: string
}
export interface PythonResult {
  dis: string
  pyc: number[]
  version: string
}
export interface DecompileResult {
  code: string
  log: string
  seconds: number
}

export type ExecutableKind = 'main' | 'helper' | 'helper app' | 'framework' | 'extension' | 'xpc' | 'library' | 'other'
export interface BundleExecutable {
  path: string
  rel: string
  kind: ExecutableKind
  size: number
  archs: string[]
}
export interface BundleInfo {
  path: string
  name: string
  identifier: string | null
  version: string | null
  build: string | null
  minOs: string | null
  executable: string | null
  info: [string, string][]
  executables: BundleExecutable[]
  frameworks: string[]
  tech: string[]
  resources: [string, number][]
  files: number
  totalSize: number
  truncated: boolean
}

interface RawExeInfo extends Omit<ExeInfo, 'entry' | 'sections' | 'symbols'> {
  entry: string | null
  sections: { name: string; addr: string; offset: number; size: number; exec: boolean }[]
  symbols: { name: string; addr: string; size: number; kind: string }[]
}

const enc = encodeURIComponent
/** Raw IPC bodies must be standalone buffers. */
const body = (b: Uint8Array) => (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : b.slice())

export const desktop = {
  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(await invoke<ArrayBuffer>('read_file', { path }))
  },
  writeFile(path: string, bytes: Uint8Array) {
    return invoke<void>('write_file', body(bytes), { headers: { 'x-path': enc(path) } })
  },
  getSettings: () => invoke<Settings>('get_settings'),
  saveSettings: (settings: Settings) => invoke<void>('save_settings', { settings }),
  getRecent: () => invoke<string[]>('get_recent'),
  addRecent: (path: string) => invoke<string[]>('add_recent', { path }),
  detectTools: () => invoke<Tools>('detect_tools'),

  async parseExecutable(bytes: Uint8Array): Promise<ExeInfo> {
    const r = await invoke<RawExeInfo>('parse_executable', body(bytes))
    return {
      ...r,
      entry: r.entry === null ? null : BigInt(r.entry),
      sections: r.sections.map((s) => ({ ...s, addr: BigInt(s.addr) })),
      symbols: r.symbols.map((s) => ({ ...s, addr: BigInt(s.addr) })),
      engine: 'goblin',
    }
  },

  compile: (request: CompileRequest) => invoke<CompileResult>('compile_source', { request }),
  pythonBytecode: (source: string, filename: string) =>
    invoke<PythonResult>('python_bytecode', { source, filename }),
  pythonDisPyc: (bytes: Uint8Array) => invoke<string>('python_dis_pyc', body(bytes)),

  ghidraDecompile(bytes: Uint8Array, name: string, processor: string, maxFunctions: number) {
    return invoke<DecompileResult>('ghidra_decompile', body(bytes), {
      headers: { 'x-name': enc(name), 'x-processor': enc(processor), 'x-max': String(maxFunctions) },
    })
  },

  inspectBundle: (path: string) => invoke<BundleInfo>('inspect_bundle', { path }),
  ghidraDecompileFile: (path: string, arch: string, processor: string, maxFunctions: number) =>
    invoke<DecompileResult>('ghidra_decompile_file', { request: { path, arch, processor, maxFunctions } }),

  async setTitle(title: string) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setTitle(title)
  },
}

export const errorText = (e: unknown) =>
  typeof e === 'string' ? e : e instanceof Error ? e.message : JSON.stringify(e)
