/** Helpers for the Ghidra output written by src-tauri/scripts/DecompileAll.java. */

export interface DecompiledFunction {
  name: string
  addr: string
  /** 1-based line of the `// ---- name @ addr ----` marker. */
  line: number
}

const MARKER = /^\/\/ ---- (.+) @ ([0-9a-fA-Fx:]+) ----$/

/** Lists the functions in Ghidra's output, in file order. */
export function splitFunctions(code: string): DecompiledFunction[] {
  const out: DecompiledFunction[] = []
  const lines = code.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER.exec(lines[i])
    if (m) out.push({ name: m[1], addr: m[2], line: i + 1 })
  }
  return out
}

/** Ghidra's placeholder names for functions with no symbol. */
export const isAutoNamed = (name: string) => /^(thunk_)?(FUN|LAB|SUB)_[0-9a-fA-F]+$/.test(name)

/** Case-insensitive match on name or address; `namedOnly` hides FUN_xxxx placeholders. */
export function filterFunctions(fns: DecompiledFunction[], query: string, namedOnly: boolean): DecompiledFunction[] {
  const q = query.trim().toLowerCase()
  return fns.filter(
    (f) => (!namedOnly || !isAutoNamed(f.name)) && (!q || f.name.toLowerCase().includes(q) || f.addr.toLowerCase().includes(q)),
  )
}

/** Suggested file name for exported output: `Notes-arm64.c`. */
export function exportName(source: string, arch?: string | null): string {
  const base = source.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, '') || 'decompiled'
  return `${base}${arch ? `-${arch}` : ''}.c`
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}
