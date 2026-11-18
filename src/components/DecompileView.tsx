import { useEffect, useMemo, useState } from 'react'
import { exportName, filterFunctions, formatSize, splitFunctions } from '../lib/decompile'
import { detectFormat, parseExecutable, type Slice } from '../lib/exe'
import {
  desktop,
  errorText,
  type BundleExecutable,
  type BundleInfo,
  type DecompileResult,
  type Tools,
} from '../platform'
import { doc, useDoc } from '../store'
import { CodeEditor } from './CodeEditor'
import { DesktopOnly } from './DesktopOnly'

/** Ghidra language IDs offered for raw (headerless) code blobs. */
const PROCESSORS = [
  ['', 'auto (ELF / PE / Mach-O)'],
  ['x86:LE:64:default', 'x86-64'],
  ['x86:LE:32:default', 'x86 32-bit'],
  ['x86:LE:16:Real Mode', 'x86 16-bit real mode'],
  ['AARCH64:LE:64:v8A', 'AArch64'],
  ['ARM:LE:32:v8', 'ARM 32-bit'],
  ['ARM:LE:32:v8T', 'ARM Thumb'],
  ['MIPS:BE:32:default', 'MIPS32 BE'],
  ['MIPS:LE:32:default', 'MIPS32 LE'],
  ['PowerPC:BE:32:default', 'PowerPC 32 BE'],
  ['RISCV:LE:64:RV64GC', 'RISC-V 64'],
  ['6502:LE:16:default', '6502'],
] as const

/** Above this size Ghidra's analysis usually needs a longer timeout than the default. */
const LARGE_BINARY = 50 * 1024 * 1024
const MAX_LISTED_FUNCTIONS = 5000

type Source = 'buffer' | 'bundle'
type View = 'info' | 'code' | 'log'

interface Result extends DecompileResult {
  from: Source
  /** File the code came from (buffer name or executable path). */
  source: string
  arch: string | null
}

export function DecompileView() {
  return (
    <DesktopOnly feature="Decompiling with Ghidra">
      <Decompile />
    </DesktopOnly>
  )
}

const preferredArch = (archs: string[]) => archs.find((a) => /^arm64/.test(a)) ?? archs[0] ?? ''

function Decompile() {
  const { bytes, rev, name } = useDoc()
  const [tools, setTools] = useState<Tools | null>(null)
  const [source, setSource] = useState<Source>('buffer')
  const [slice, setSlice] = useState<Slice | null>(null)
  const [processor, setProcessor] = useState('')
  const [maxFns, setMaxFns] = useState(500)
  const [result, setResult] = useState<Result | null>(null)
  const [view, setView] = useState<View>('info')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  // App bundle mode
  const [bundlePath, setBundlePath] = useState('')
  const [bundle, setBundle] = useState<BundleInfo | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [exePath, setExePath] = useState<string | null>(null)
  const [arch, setArch] = useState('')

  useEffect(() => {
    desktop.detectTools().then(setTools).catch((e) => setError(errorText(e)))
  }, [])

  // A new buffer invalidates buffer results, but not results taken from an app bundle on disk.
  useEffect(() => {
    setSlice(null)
    setResult((r) => (r?.from === 'buffer' ? null : r))
  }, [rev])

  const format = useMemo(() => detectFormat(bytes), [bytes, rev])
  const slices = useMemo(() => {
    if (format !== 'Mach-O (fat)') return []
    try {
      return parseExecutable(bytes).slices
    } catch {
      return []
    }
  }, [bytes, rev, format])

  useEffect(() => {
    if (slices.length && !slice) setSlice(slices.find((s) => /arm64/i.test(s.label)) ?? slices[0])
  }, [slices, slice])

  useEffect(() => {
    if (!busy) return
    const start = Date.now()
    const t = setInterval(() => setElapsed((Date.now() - start) / 1000), 250)
    return () => clearInterval(t)
  }, [busy])

  const exe = bundle?.executables.find((e) => e.path === exePath) ?? null
  const needsProcessor = source === 'buffer' && !format
  const input = slice ? bytes.subarray(slice.offset, slice.offset + slice.size) : bytes

  const selectExe = (e: BundleExecutable) => {
    setExePath(e.path)
    setArch(preferredArch(e.archs))
  }

  const inspect = async (path: string) => {
    const p = path.trim()
    if (!p) return
    setBundlePath(p)
    setInspecting(true)
    setError(null)
    try {
      const b = await desktop.inspectBundle(p)
      setBundle(b)
      setView('info')
      if (b.executables[0]) selectExe(b.executables[0])
      else setExePath(null)
    } catch (e) {
      setBundle(null)
      setError(errorText(e))
    } finally {
      setInspecting(false)
    }
  }

  const chooseApp = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const picked = await open({
        title: 'Choose an app bundle',
        filters: [{ name: 'Apps and bundles', extensions: ['app', 'appex', 'framework', 'bundle', 'xpc'] }],
      })
      if (typeof picked === 'string') await inspect(picked)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const run = async () => {
    setBusy(true)
    setElapsed(0)
    setError(null)
    try {
      if (source === 'bundle') {
        if (!exe) return
        const r = await desktop.ghidraDecompileFile(exe.path, arch, '', maxFns)
        setResult({ ...r, from: 'bundle', source: exe.path, arch: exe.archs.length > 1 ? arch : (exe.archs[0] ?? null) })
      } else {
        const r = await desktop.ghidraDecompile(input, name, processor, maxFns)
        setResult({ ...r, from: 'buffer', source: name, arch: slice?.label ?? null })
      }
      setView('code')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const exportCode = async () => {
    if (!result) return
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const target = await save({
        defaultPath: exportName(result.source, result.arch),
        filters: [{ name: 'C source', extensions: ['c'] }],
      })
      if (target) await desktop.writeFile(target, new TextEncoder().encode(result.code))
    } catch (e) {
      setError(errorText(e))
    }
  }

  const ghidraMissing = tools && !tools.ghidra.path
  const canRun =
    !busy &&
    !ghidraMissing &&
    (source === 'bundle' ? !!exe : bytes.length > 0 && !(needsProcessor && !processor))
  const shown = result?.from === source ? result : null

  return (
    <div className="flex h-full flex-col">
      <div className="pane-header flex-wrap">
        <span className="font-semibold">Ghidra decompiler</span>
        <span className="text-dim">
          {tools?.ghidra.version ?? (tools ? 'not found' : 'detecting…')}
          {tools?.javaHome ? '' : tools ? ' · no JDK found' : ''}
        </span>
        <span className="mx-1 h-4 w-px bg-line" />
        <div className="flex overflow-hidden rounded border border-line" role="group" aria-label="Input">
          {(
            [
              ['buffer', 'Current buffer'],
              ['bundle', 'App bundle'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={`px-2 py-0.5 ${source === id ? 'bg-sel text-white' : 'bg-panel-2 text-dim hover:text-fg'}`}
              aria-pressed={source === id}
              onClick={() => {
                setSource(id)
                setError(null)
                setView(result?.from === id ? 'code' : 'info')
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {source === 'buffer' ? (
          <>
            <span className="text-dim">
              {name} · {format ?? 'raw bytes'} · {input.length.toLocaleString()} B
            </span>
            {slices.length > 0 && (
              <select
                className="field"
                value={slice?.offset ?? ''}
                onChange={(e) => setSlice(slices.find((s) => s.offset === Number(e.target.value)) ?? null)}
              >
                {slices.map((s) => (
                  <option key={s.offset} value={s.offset}>
                    {s.label}
                  </option>
                ))}
              </select>
            )}
            <select
              className={`field ${needsProcessor && !processor ? 'border-warn' : ''}`}
              value={processor}
              onChange={(e) => setProcessor(e.target.value)}
              title="Required for raw code without an executable header"
            >
              {PROCESSORS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </>
        ) : (
          exe && (
            <span className="truncate text-dim" title={exe.path}>
              {exe.rel.split('/').pop()} · {arch || exe.archs[0]} · {formatSize(exe.size)}
            </span>
          )
        )}

        <label className="flex items-center gap-1 text-dim">
          max functions
          <input
            className="field w-16"
            type="number"
            min={1}
            value={maxFns}
            onChange={(e) => setMaxFns(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <button className="btn-primary ml-auto" onClick={run} disabled={!canRun}>
          {busy ? `Analyzing… ${elapsed.toFixed(0)}s` : 'Decompile'}
        </button>
        {source === 'bundle' && bundle && result?.from === 'bundle' && (
          <button
            className={`btn ${view === 'info' ? 'border-accent' : ''}`}
            onClick={() => setView('info')}
            title="Back to the bundle overview"
          >
            Overview
          </button>
        )}
        {result?.from === source && (
          <>
            <button className={`btn ${view === 'code' ? 'border-accent' : ''}`} onClick={() => setView('code')}>
              Code
            </button>
            <button className={`btn ${view === 'log' ? 'border-accent' : ''}`} onClick={() => setView('log')}>
              Log
            </button>
            <button className="btn" onClick={exportCode} title="Save the decompiled code as a .c file">
              Export…
            </button>
          </>
        )}
      </div>

      {source === 'bundle' && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel px-2 text-xs">
          <button className="btn" onClick={chooseApp} disabled={inspecting}>
            Choose app…
          </button>
          <input
            className="field min-w-0 flex-1 font-mono"
            placeholder="/Applications/Example.app — or paste a path and press Enter"
            aria-label="App bundle path"
            value={bundlePath}
            onChange={(e) => setBundlePath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && inspect(bundlePath)}
          />
          <button className="btn" onClick={() => inspect(bundlePath)} disabled={inspecting || !bundlePath.trim()}>
            {inspecting ? 'Inspecting…' : 'Inspect'}
          </button>
        </div>
      )}

      {ghidraMissing && (
        <p className="border-b border-line px-3 py-2 text-xs text-warn">
          Ghidra was not found. Install it (macOS: <code>brew install ghidra</code>) or set its folder in Settings.
        </p>
      )}
      {needsProcessor && !processor && (
        <p className="border-b border-line px-3 py-2 text-xs text-dim">
          The buffer has no ELF / PE / Mach-O header — choose a processor so Ghidra can load it as raw code.
        </p>
      )}
      {source === 'bundle' && exe && exe.size > LARGE_BINARY && !shown && (
        <p className="border-b border-line px-3 py-2 text-xs text-warn">
          This executable is {formatSize(exe.size)}. Ghidra may need many minutes — raise the Ghidra timeout in ⚙
          Settings and keep “max functions” low for a first look.
        </p>
      )}

      <div className="min-h-0 flex-1">
        {error ? (
          <pre className="h-full overflow-auto p-3 font-mono text-xs whitespace-pre-wrap text-warn">{error}</pre>
        ) : shown && view === 'log' ? (
          <pre className="h-full overflow-auto p-3 font-mono text-xs whitespace-pre-wrap text-dim">{shown.log}</pre>
        ) : shown && view === 'code' ? (
          <CodeView result={shown} />
        ) : source === 'bundle' ? (
          bundle ? (
            <BundlePanel bundle={bundle} selected={exePath} arch={arch} onSelect={selectExe} onArch={setArch} />
          ) : (
            <div className="space-y-2 p-6 text-dim">
              <p>
                Choose a macOS app (<code>.app</code>), app extension, framework or plug-in bundle. The editor lists
                what is inside — its executables, frameworks, resources and Info.plist — and recognises what it was
                built with. Pick any executable to decompile it with Ghidra.
              </p>
              <p>
                Everything is read from disk and analyzed; nothing inside the bundle is ever run. Decompiled output is
                Ghidra's reconstruction for study and analysis — not the app's original source code.
              </p>
            </div>
          )
        ) : (
          <div className="p-6 text-dim">
            Ghidra imports the current buffer, runs its auto-analysis and decompiles every function to C-like code.
            This takes from a few seconds to several minutes. The binary is analyzed, never executed.
          </div>
        )}
      </div>
    </div>
  )
}

function CodeView({ result }: { result: Result }) {
  const fns = useMemo(() => splitFunctions(result.code), [result.code])
  const [query, setQuery] = useState('')
  const [namedOnly, setNamedOnly] = useState(false)
  const [reveal, setReveal] = useState<{ line: number } | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const filtered = useMemo(() => filterFunctions(fns, query, namedOnly), [fns, query, namedOnly])
  const lines = useMemo(() => result.code.split('\n').length, [result.code])

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel text-xs">
          <div className="space-y-1 border-b border-line p-2">
            <input
              className="field w-full"
              placeholder="Filter functions"
              aria-label="Filter functions"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="flex items-center gap-1 text-dim">
              <input type="checkbox" checked={namedOnly} onChange={(e) => setNamedOnly(e.target.checked)} />
              hide unnamed (FUN_…)
            </label>
            <div className="text-dim">
              {filtered.length.toLocaleString()} of {fns.length.toLocaleString()} functions
            </div>
          </div>
          <ul className="min-h-0 flex-1 overflow-auto" aria-label="Functions">
            {filtered.slice(0, MAX_LISTED_FUNCTIONS).map((f) => (
              <li key={`${f.addr}-${f.line}`}>
                <button
                  className={`block w-full truncate px-2 py-0.5 text-left font-mono hover:bg-panel-2 ${
                    active === f.addr ? 'bg-sel text-white' : 'text-fg'
                  }`}
                  title={`${f.name} @ ${f.addr}`}
                  onClick={() => {
                    setActive(f.addr)
                    setReveal({ line: f.line })
                  }}
                >
                  {f.name}
                </button>
              </li>
            ))}
            {filtered.length > MAX_LISTED_FUNCTIONS && (
              <li className="px-2 py-1 text-dim">… refine the filter to see the rest</li>
            )}
          </ul>
        </aside>
        <div className="min-w-0 flex-1">
          <CodeEditor value={result.code} readOnly language="cpp" reveal={reveal} />
        </div>
      </div>
      <div className="flex h-6 shrink-0 items-center gap-2 border-t border-line bg-panel px-2 text-xs text-dim">
        <span className="truncate" title={result.source}>
          {result.source.split(/[\\/]/).pop()}
          {result.arch ? ` · ${result.arch}` : ''}
        </span>
        <span>
          · finished in {result.seconds.toFixed(1)}s · {lines.toLocaleString()} lines
        </span>
      </div>
    </div>
  )
}

const KIND_LABEL: Record<string, string> = {
  main: 'main',
  helper: 'helper',
  'helper app': 'helper app',
  framework: 'framework',
  extension: 'extension',
  xpc: 'XPC service',
  library: 'library',
  other: 'other',
}

function BundlePanel({
  bundle,
  selected,
  arch,
  onSelect,
  onArch,
}: {
  bundle: BundleInfo
  selected: string | null
  arch: string
  onSelect: (e: BundleExecutable) => void
  onArch: (a: string) => void
}) {
  const [opening, setOpening] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)

  const openInEditor = async (path: string) => {
    setOpening(path)
    setOpenError(null)
    try {
      await doc.openPath(path)
    } catch (e) {
      setOpenError(errorText(e))
    } finally {
      setOpening(null)
    }
  }

  const facts: [string, string | null][] = [
    ['Identifier', bundle.identifier],
    ['Version', bundle.version ? `${bundle.version}${bundle.build ? ` (${bundle.build})` : ''}` : bundle.build],
    ['Minimum OS', bundle.minOs],
    ['Main executable', bundle.executable],
    ['Contents', `${bundle.files.toLocaleString()} files · ${formatSize(bundle.totalSize)}`],
  ]

  return (
    <div className="h-full space-y-4 overflow-auto p-4 text-xs" aria-label="Bundle overview">
      <section>
        <h2 className="mb-1 text-base font-semibold text-fg">{bundle.name}</h2>
        <p className="mb-2 truncate font-mono text-dim" title={bundle.path}>
          {bundle.path}
        </p>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5">
          {facts
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-dim">{k}</dt>
                <dd className="font-mono text-fg">{v}</dd>
              </div>
            ))}
        </dl>
        {bundle.truncated && (
          <p className="mt-2 text-warn">Very large bundle — the listing stopped after 100,000 files.</p>
        )}
      </section>

      {bundle.tech.length > 0 && (
        <section>
          <h3 className="mb-1 font-semibold text-fg">Built with</h3>
          <ul className="flex flex-wrap gap-1">
            {bundle.tech.map((t) => (
              <li key={t} className="rounded border border-line bg-panel-2 px-1.5 py-0.5 text-fg">
                {t}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="mb-1 font-semibold text-fg">
          Executables <span className="font-normal text-dim">({bundle.executables.length}) — pick one to decompile</span>
        </h3>
        {openError && <p className="mb-1 text-warn">{openError}</p>}
        {bundle.executables.length === 0 ? (
          <p className="text-dim">No Mach-O executables found in this bundle.</p>
        ) : (
          <table className="w-full border-collapse">
            <thead className="text-left text-dim">
              <tr className="border-b border-line">
                <th className="w-6 py-1" />
                <th className="py-1 pr-3 font-normal">Kind</th>
                <th className="py-1 pr-3 font-normal">Path</th>
                <th className="py-1 pr-3 text-right font-normal">Size</th>
                <th className="py-1 pr-3 font-normal">Architecture</th>
                <th className="py-1 font-normal" />
              </tr>
            </thead>
            <tbody>
              {bundle.executables.map((e) => {
                const isSel = e.path === selected
                return (
                  <tr
                    key={e.path}
                    className={`cursor-pointer border-b border-line/50 ${isSel ? 'bg-panel-2' : 'hover:bg-panel-2/60'}`}
                    onClick={() => onSelect(e)}
                  >
                    <td className="py-0.5">
                      <input
                        type="radio"
                        name="bundle-exe"
                        aria-label={`Decompile ${e.rel}`}
                        checked={isSel}
                        onChange={() => onSelect(e)}
                      />
                    </td>
                    <td className={`py-0.5 pr-3 ${e.kind === 'main' ? 'text-accent' : 'text-dim'}`}>
                      {KIND_LABEL[e.kind] ?? e.kind}
                    </td>
                    <td className="max-w-0 truncate py-0.5 pr-3 font-mono text-fg" title={e.rel}>
                      {e.rel}
                    </td>
                    <td className="py-0.5 pr-3 text-right whitespace-nowrap text-dim">{formatSize(e.size)}</td>
                    <td className="py-0.5 pr-3 whitespace-nowrap">
                      {isSel && e.archs.length > 1 ? (
                        <select
                          className="field"
                          aria-label="Architecture"
                          value={arch}
                          onClick={(ev) => ev.stopPropagation()}
                          onChange={(ev) => onArch(ev.target.value)}
                        >
                          {e.archs.map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="font-mono text-dim">{e.archs.join(', ')}</span>
                      )}
                    </td>
                    <td className="py-0.5 text-right whitespace-nowrap">
                      <button
                        className="text-dim hover:text-accent"
                        title="Load into the editor buffer (Hex Editor, Disassemble tabs)"
                        disabled={opening !== null}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          openInEditor(e.path)
                        }}
                      >
                        {opening === e.path ? 'Opening…' : 'Open in editor'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        {bundle.frameworks.length > 0 && (
          <section>
            <h3 className="mb-1 font-semibold text-fg">
              Embedded frameworks <span className="font-normal text-dim">({bundle.frameworks.length})</span>
            </h3>
            <ul className="flex flex-wrap gap-1">
              {bundle.frameworks.map((f) => (
                <li key={f} className="rounded border border-line px-1.5 py-0.5 font-mono text-dim">
                  {f}
                </li>
              ))}
            </ul>
          </section>
        )}
        {bundle.resources.length > 0 && (
          <section>
            <h3 className="mb-1 font-semibold text-fg">Resources</h3>
            <dl className="grid grid-cols-[1fr_max-content] gap-x-4 gap-y-0.5">
              {bundle.resources.map(([k, n]) => (
                <div key={k} className="contents">
                  <dt className="text-dim">{k}</dt>
                  <dd className="text-right font-mono text-fg">{n.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>

      <details>
        <summary className="cursor-pointer font-semibold text-fg">
          Info.plist <span className="font-normal text-dim">({bundle.info.length} keys)</span>
        </summary>
        <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5">
          {bundle.info.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-dim">{k}</dt>
              <dd className="truncate font-mono text-fg" title={v}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  )
}
