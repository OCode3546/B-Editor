import { useEffect, useMemo, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { CS_TARGETS, disassemble, isWasm, wasmToWat, watToWasm, type Instruction } from '../lib/disasm'
import { formatBytes, parseHex } from '../lib/encoding'
import { hex, parseExecutable, type CsTarget, type ExeInfo, type Section } from '../lib/exe'
import { desktop, isDesktop } from '../platform'
import { doc, download, useDoc } from '../store'
import { CodeEditor } from './CodeEditor'
import { Listing } from './Listing'

type Sub = 'wasm' | 'machine' | 'exe'

export function DisasmView() {
  const [sub, setSub] = useState<Sub>('exe')
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 border-b border-line bg-panel">
        {(
          [
            ['exe', 'Executable (ELF / PE / Mach-O)'],
            ['machine', 'Machine code (Capstone)'],
            ['wasm', 'WASM ↔ WAT (wabt)'],
          ] as [Sub, string][]
        ).map(([id, label]) => (
          <button key={id} className={`tab text-xs ${sub === id ? 'tab-active' : ''}`} onClick={() => setSub(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {sub === 'wasm' && <WasmPanel />}
        {sub === 'machine' && <MachinePanel />}
        {sub === 'exe' && <ExePanel />}
      </div>
    </div>
  )
}

// ---------------- WASM <-> WAT ----------------

const SAMPLE_WAT = `(module
  (func $add (export "add") (param $a i32) (param $b i32) (result i32)
    local.get $a
    local.get $b
    i32.add)
  (memory (export "memory") 1)
  (data (i32.const 0) "Hello, binary!"))
`

function WasmPanel() {
  const { bytes, rev } = useDoc()
  const [wat, setWat] = useState(SAMPLE_WAT)
  const [wasm, setWasm] = useState<Uint8Array | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      watToWasm(wat)
        .then((b) => alive && (setWasm(b), setError(null)))
        .catch((e) => alive && (setWasm(null), setError(String(e.message ?? e))))
    }, 250)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [wat])

  const bufferIsWasm = useMemo(() => isWasm(bytes), [bytes, rev])

  const fromBuffer = async () => {
    try {
      setWat(await wasmToWat(bytes))
    } catch (e) {
      setError(`Disassemble failed: ${(e as Error).message}`)
    }
  }

  return (
    <Group orientation="horizontal" className="h-full">
      <Panel defaultSize="55" minSize="20" className="flex h-full flex-col">
        <div className="pane-header">
          <span className="font-semibold">WAT (text)</span>
          <button className="btn" onClick={fromBuffer} disabled={!bufferIsWasm} title={bufferIsWasm ? '' : 'Buffer is not a .wasm file'}>
            ← Disassemble buffer (.wasm)
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <CodeEditor value={wat} onChange={setWat} language="wat" />
        </div>
      </Panel>
      <Separator className="separator" />
      <Panel defaultSize="45" minSize="20" className="flex h-full flex-col">
        <div className="pane-header">
          <span className="font-semibold">WASM (binary)</span>
          {wasm && (
            <>
              <span className="text-ok">✓ {wasm.length} bytes</span>
              <button className="btn ml-auto" onClick={() => doc.replace(wasm)}>
                Use as buffer
              </button>
              <button className="btn" onClick={() => download(wasm, 'module.wasm')}>
                Download
              </button>
            </>
          )}
        </div>
        {error ? (
          <pre className="min-h-0 flex-1 overflow-auto p-3 text-xs whitespace-pre-wrap text-warn">{error}</pre>
        ) : (
          <div className="min-h-0 flex-1">
            <CodeEditor value={wasm ? formatBytes(wasm, 'hex') : ''} readOnly language="bytes" />
          </div>
        )}
      </Panel>
    </Group>
  )
}

// ---------------- Raw machine code ----------------

function parseAddr(s: string): bigint | null {
  const t = s.trim()
  try {
    return /^0x/i.test(t) ? BigInt(t) : /^\d+$/.test(t) ? BigInt(t) : BigInt('0x' + t)
  } catch {
    return null
  }
}

function useDisasm(code: Uint8Array | null, target: CsTarget, base: bigint | null, att: boolean) {
  const [state, setState] = useState<{ insns: Instruction[]; error: string | null; busy: boolean }>({
    insns: [],
    error: null,
    busy: false,
  })
  useEffect(() => {
    if (!code || base === null) {
      setState({ insns: [], error: base === null ? 'Invalid base address' : null, busy: false })
      return
    }
    let alive = true
    setState((s) => ({ ...s, busy: true }))
    disassemble(code, target, base, { att })
      .then((insns) => alive && setState({ insns, error: null, busy: false }))
      .catch((e) => alive && setState({ insns: [], error: String(e?.message ?? e), busy: false }))
    return () => {
      alive = false
    }
  }, [code, target, base, att])
  return state
}

function TargetSelect({ value, onChange }: { value: CsTarget; onChange: (t: CsTarget) => void }) {
  return (
    <select className="field" value={value} onChange={(e) => onChange(e.target.value as CsTarget)}>
      {CS_TARGETS.map((t) => (
        <option key={t.id} value={t.id}>
          {t.label}
        </option>
      ))}
    </select>
  )
}

function MachinePanel() {
  const { bytes, rev } = useDoc()
  const [source, setSource] = useState<'buffer' | 'hex'>('hex')
  const [hexIn, setHexIn] = useState('55 48 89 e5 48 83 ec 10 89 7d fc 8b 45 fc 0f af c0 c9 c3')
  const [target, setTarget] = useState<CsTarget>('x86-64')
  const [baseText, setBaseText] = useState('0x1000')
  const [startText, setStartText] = useState('0')
  const [lenText, setLenText] = useState('')
  const [att, setAtt] = useState(false)

  const { code, inputError } = useMemo(() => {
    if (source === 'hex') {
      try {
        return { code: parseHex(hexIn), inputError: null }
      } catch (e) {
        return { code: null, inputError: (e as Error).message }
      }
    }
    const start = Number(parseAddr(startText || '0') ?? 0)
    const len = lenText.trim() ? Number(parseAddr(lenText) ?? 0) : bytes.length - start
    return { code: bytes.slice(start, start + len), inputError: null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, hexIn, bytes, rev, startText, lenText])

  const base = parseAddr(baseText)
  const { insns, error, busy } = useDisasm(code, target, base, att)

  return (
    <Group orientation="horizontal" className="h-full">
      <Panel defaultSize="35" minSize="20" className="flex h-full flex-col">
        <div className="pane-header">
          <span className="font-semibold">Input</span>
          <button className={source === 'hex' ? 'btn-primary' : 'btn'} onClick={() => setSource('hex')}>
            hex text
          </button>
          <button className={source === 'buffer' ? 'btn-primary' : 'btn'} onClick={() => setSource('buffer')}>
            buffer
          </button>
        </div>
        {source === 'hex' ? (
          <div className="min-h-0 flex-1">
            <CodeEditor value={hexIn} onChange={setHexIn} language="bytes" wordWrap />
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-3 text-xs">
            <label className="flex items-center gap-2">
              <span className="w-24 text-dim">start offset</span>
              <input className="field font-mono" value={startText} onChange={(e) => setStartText(e.target.value)} />
            </label>
            <label className="flex items-center gap-2">
              <span className="w-24 text-dim">length</span>
              <input
                className="field font-mono"
                placeholder="to end"
                value={lenText}
                onChange={(e) => setLenText(e.target.value)}
              />
            </label>
            <p className="text-dim">Disassembling {code?.length ?? 0} bytes of the current buffer.</p>
          </div>
        )}
      </Panel>
      <Separator className="separator" />
      <Panel defaultSize="65" minSize="30" className="flex h-full flex-col">
        <div className="pane-header">
          <TargetSelect value={target} onChange={setTarget} />
          <span className="text-dim">base</span>
          <input className="field w-28 font-mono" value={baseText} onChange={(e) => setBaseText(e.target.value)} />
          {target.startsWith('x86') && (
            <button className={att ? 'btn-primary' : 'btn'} onClick={() => setAtt(!att)}>
              AT&T
            </button>
          )}
          <span className={`ml-auto truncate ${inputError || error ? 'text-warn' : 'text-dim'}`}>
            {inputError ?? error ?? (busy ? 'working…' : `${insns.length.toLocaleString()} instructions`)}
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <Listing insns={insns} />
        </div>
      </Panel>
    </Group>
  )
}

// ---------------- Executables ----------------

function ExePanel() {
  const { bytes, rev, name } = useDoc()
  const [slice, setSlice] = useState<{ offset: number; size: number; label: string } | null>(null)
  const [section, setSection] = useState<Section | null>(null)
  const [target, setTarget] = useState<CsTarget>('x86-64')
  const [att, setAtt] = useState(false)

  useEffect(() => {
    setSlice(null)
    setSection(null)
  }, [rev])

  const data = useMemo(
    () => (slice ? bytes.subarray(slice.offset, slice.offset + slice.size) : bytes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bytes, rev, slice],
  )

  const parsed = useMemo((): { info: ExeInfo | null; error: string | null } => {
    try {
      return { info: parseExecutable(data), error: null }
    } catch (e) {
      return { info: null, error: (e as Error).message }
    }
  }, [data])

  // Desktop: re-parse with goblin (adds symbols and libraries).
  const [goblin, setGoblin] = useState<{ data: Uint8Array; info: ExeInfo } | null>(null)
  useEffect(() => {
    if (!isDesktop || !parsed.info || parsed.info.slices.length) return
    let alive = true
    desktop
      .parseExecutable(data)
      .then((info) => alive && setGoblin({ data, info }))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [data, parsed.info])
  const info = goblin && goblin.data === data ? goblin.info : parsed.info
  const [jump, setJump] = useState<bigint | null>(null)
  const [symFilter, setSymFilter] = useState('')
  const symbols = useMemo(() => {
    const all = info?.symbols ?? []
    const f = symFilter.trim().toLowerCase()
    return (f ? all.filter((s) => s.name.toLowerCase().includes(f)) : all).slice(0, 1000)
  }, [info, symFilter])

  useEffect(() => {
    if (info?.target) setTarget(info.target)
    if (info && !section) {
      const entrySec = info.entry !== null ? info.sections.find((s) => containsAddr(s, info.entry!)) : undefined
      setSection(entrySec ?? info.sections.find((s) => s.exec && s.size > 0) ?? null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info])

  const code = useMemo(() => {
    if (!section || !section.size) return null
    return data.subarray(section.offset, Math.min(section.offset + section.size, data.length))
  }, [data, section])

  const { insns, error, busy } = useDisasm(code, target, section?.addr ?? 0n, att)

  if (!info) {
    return (
      <div className="p-6 text-dim">
        <p className="mb-2">
          <span className="text-fg">{name}</span> — {parsed.error}
        </p>
        <p>Open an executable (ELF, PE/.exe/.dll, Mach-O) with File → Open. It is only parsed and disassembled, never run.</p>
      </div>
    )
  }

  return (
    <Group orientation="horizontal" className="h-full">
      <Panel defaultSize="38" minSize="20" className="flex h-full flex-col overflow-auto bg-panel text-xs">
        <div className="pane-header">
          <span className="font-semibold">
            {info.format} · {info.arch} · {info.bits}-bit · {info.little ? 'LE' : 'BE'}
          </span>
          <span className="text-dim">{info.engine === 'goblin' ? 'goblin' : 'built-in parser'}</span>
          {slice && (
            <button className="btn ml-auto" onClick={() => (setSlice(null), setSection(null))}>
              ← all slices
            </button>
          )}
        </div>
        <table className="w-full font-mono">
          <tbody>
            {info.fields.map(([k, v]) => (
              <tr key={k} className="border-b border-line/50">
                <td className="w-36 px-2 py-1 text-dim">{k}</td>
                <td className="px-2 py-1 select-text">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {info.slices.length > 0 && (
          <>
            <h3 className="px-2 pt-3 pb-1 font-semibold">Architectures</h3>
            {info.slices.map((s) => (
              <button
                key={s.offset}
                className="mx-2 mb-1 block w-[calc(100%-1rem)] rounded border border-line px-2 py-1 text-left font-mono hover:border-accent"
                onClick={() => (setSlice(s), setSection(null))}
              >
                {s.label} — {s.size.toLocaleString()} bytes @ {hex(s.offset)}
              </button>
            ))}
          </>
        )}

        {info.sections.length > 0 && (
          <>
            <h3 className="px-2 pt-3 pb-1 font-semibold">Sections ({info.sections.length})</h3>
            <table className="w-full font-mono">
              <thead className="text-dim">
                <tr>
                  <th className="px-2 text-left font-normal">name</th>
                  <th className="px-2 text-left font-normal">address</th>
                  <th className="px-2 text-right font-normal">size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {info.sections.map((s, i) => (
                  <tr
                    key={i}
                    onClick={() => {
                      if (!s.size) return
                      setSection(s)
                      setJump(null)
                    }}
                    className={`border-b border-line/50 ${s.size ? 'cursor-pointer hover:bg-panel-2' : 'text-dim'} ${sameSection(section, s) ? 'bg-sel' : ''}`}
                  >
                    <td className="max-w-[18ch] truncate px-2 py-0.5" title={s.name}>
                      {s.name}
                    </td>
                    <td className="px-2">{hex(s.addr)}</td>
                    <td className="px-2 text-right">{s.size.toLocaleString()}</td>
                    <td className="px-2 text-ok">{s.exec ? 'code' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {info.symbols && info.symbols.length > 0 && (
          <>
            <h3 className="flex items-center gap-2 px-2 pt-3 pb-1 font-semibold">
              Symbols ({info.symbols.length.toLocaleString()})
              <input
                className="field ml-auto w-40 font-mono font-normal"
                placeholder="filter…"
                value={symFilter}
                onChange={(e) => setSymFilter(e.target.value)}
              />
            </h3>
            <table className="w-full font-mono">
              <tbody>
                {symbols.map((sym, i) => (
                  <tr
                    key={i}
                    className={`cursor-pointer border-b border-line/50 hover:bg-panel-2 ${jump === sym.addr ? 'bg-sel' : ''}`}
                    onClick={() => {
                      const sec = info.sections.find((x) => containsAddr(x, sym.addr))
                      if (sec) setSection(sec)
                      setJump(sym.addr)
                    }}
                  >
                    <td className="max-w-[26ch] truncate px-2 py-0.5" title={sym.name}>
                      {sym.name}
                    </td>
                    <td className="px-2">{hex(sym.addr)}</td>
                    <td className="px-2 text-dim">{sym.kind}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {info.libraries && info.libraries.length > 0 && (
          <>
            <h3 className="px-2 pt-3 pb-1 font-semibold">Libraries ({info.libraries.length})</h3>
            <ul className="px-2 pb-3 font-mono">
              {info.libraries.map((l) => (
                <li key={l} className="truncate py-0.5 text-dim" title={l}>
                  {l}
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
      <Separator className="separator" />
      <Panel defaultSize="62" minSize="30" className="flex h-full flex-col">
        <div className="pane-header">
          <span className="font-semibold">{section ? section.name : 'Select a section'}</span>
          <TargetSelect value={target} onChange={setTarget} />
          {target.startsWith('x86') && (
            <button className={att ? 'btn-primary' : 'btn'} onClick={() => setAtt(!att)}>
              AT&T
            </button>
          )}
          <span className={`ml-auto truncate ${error ? 'text-warn' : 'text-dim'}`}>
            {error ?? (busy ? 'working…' : section ? `${insns.length.toLocaleString()} instructions` : '')}
          </span>
        </div>
        {section && !section.exec && !busy && (
          <p className="shrink-0 border-b border-line px-2 py-1 text-xs text-warn">
            Not marked executable — output may be data decoded as instructions.
          </p>
        )}
        <div className="min-h-0 flex-1">
          <Listing insns={insns} highlight={jump ?? info.entry} />
        </div>
      </Panel>
    </Group>
  )
}

function sameSection(a: Section | null, b: Section) {
  return !!a && a.name === b.name && a.offset === b.offset && a.addr === b.addr
}

function containsAddr(s: Section, a: bigint) {
  return s.size > 0 && a >= s.addr && a < s.addr + BigInt(s.size)
}
