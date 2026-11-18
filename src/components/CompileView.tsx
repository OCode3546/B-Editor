import { useCallback, useEffect, useRef, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { desktop, errorText, type CompileRequest } from '../platform'
import { doc, useDoc } from '../store'
import { CodeEditor } from './CodeEditor'
import { DesktopOnly } from './DesktopOnly'

type Lang = 'c' | 'cpp' | 'rust' | 'python'

const SAMPLES: Record<Lang, string> = {
  c: `int square(int x) {
    return x * x;
}

int sum(const int *a, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s += a[i];
    return s;
}
`,
  cpp: `#include <vector>
#include <numeric>

int total(const std::vector<int>& v) {
    return std::accumulate(v.begin(), v.end(), 0);
}
`,
  rust: `#[no_mangle]
pub fn square(x: i32) -> i32 {
    x.wrapping_mul(x)
}

#[no_mangle]
pub fn sum(v: &[i32]) -> i32 {
    v.iter().sum()
}
`,
  python: `def greet(name):
    return f"Hello, {name}!"

for i in range(3):
    print(greet(i))
`,
}

const MONACO: Record<Lang, string> = { c: 'cpp', cpp: 'cpp', rust: 'rust', python: 'python' }
const TARGETS = [
  ['native', 'native'],
  ['x86_64-linux', 'x86-64 Linux'],
  ['aarch64-linux', 'AArch64 Linux'],
  ['x86_64-windows', 'x86-64 Windows'],
  ['x86_64-macos', 'x86-64 macOS'],
  ['arm64-macos', 'ARM64 macOS'],
  ['wasm32', 'WebAssembly'],
] as const

export function CompileView() {
  return (
    <DesktopOnly feature="Compiling source code">
      <Compile />
    </DesktopOnly>
  )
}

function Compile() {
  const { bytes, name } = useDoc()
  const [lang, setLang] = useState<Lang>('c')
  const [sources, setSources] = useState<Record<Lang, string>>(SAMPLES)
  const [opt, setOpt] = useState<CompileRequest['opt']>('2')
  const [target, setTarget] = useState('native')
  const [intel, setIntel] = useState(true)
  const [auto, setAuto] = useState(true)
  const [output, setOutput] = useState('')
  const [info, setInfo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  const source = sources[lang]

  const compile = useCallback(
    async (wantObject: boolean) => {
      const id = ++seq.current
      setBusy(true)
      try {
        if (lang === 'python') {
          const r = await desktop.pythonBytecode(source, 'editor.py')
          if (id !== seq.current) return
          setOutput(r.dis)
          setInfo(`Python ${r.version} · compile() + dis · ${r.pyc.length} byte .pyc`)
          if (wantObject) doc.load(new Uint8Array(r.pyc), 'editor.pyc')
        } else {
          const r = await desktop.compile({ language: lang, source, opt, target, intel, object: wantObject })
          if (id !== seq.current) return
          setOutput(r.asm)
          setInfo(r.command + (r.diagnostics.trim() ? `\n${r.diagnostics.trim()}` : ''))
          if (wantObject && r.object) doc.load(new Uint8Array(r.object), 'input.o')
        }
        setError(null)
      } catch (e) {
        if (id === seq.current) setError(errorText(e))
      } finally {
        if (id === seq.current) setBusy(false)
      }
    },
    [lang, source, opt, target, intel],
  )

  useEffect(() => {
    if (!auto) return
    const t = setTimeout(() => compile(false), 600)
    return () => clearTimeout(t)
  }, [auto, compile])

  const disPyc = async () => {
    setBusy(true)
    try {
      setOutput(await desktop.pythonDisPyc(bytes))
      setInfo(`dis of ${name} (current buffer)`)
      setError(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Group orientation="horizontal" className="h-full">
      <Panel defaultSize="50" minSize="20" className="flex h-full flex-col">
        <div className="pane-header">
          <span className="font-semibold">Source</span>
          <select className="field" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            <option value="c">C (clang)</option>
            <option value="cpp">C++ (clang)</option>
            <option value="rust">Rust (rustc)</option>
            <option value="python">Python (bytecode)</option>
          </select>
          {lang !== 'python' && (
            <>
              <select className="field" value={opt} onChange={(e) => setOpt(e.target.value as CompileRequest['opt'])}>
                {(['0', '1', '2', '3', 's'] as const).map((o) => (
                  <option key={o} value={o}>
                    -O{o}
                  </option>
                ))}
              </select>
              <select className="field" value={target} onChange={(e) => setTarget(e.target.value)}>
                {TARGETS.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              <button className={intel ? 'btn-primary' : 'btn'} onClick={() => setIntel(!intel)} title="x86 only">
                Intel
              </button>
            </>
          )}
          <label className="ml-auto flex items-center gap-1 text-dim">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto
          </label>
          <button className="btn" onClick={() => compile(false)} disabled={busy}>
            Compile
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <CodeEditor
            value={source}
            onChange={(v) => setSources((s) => ({ ...s, [lang]: v }))}
            language={MONACO[lang]}
          />
        </div>
      </Panel>
      <Separator className="separator" />
      <Panel defaultSize="50" minSize="20" className="flex h-full flex-col">
        <div className="pane-header">
          <span className="font-semibold">{lang === 'python' ? 'Bytecode' : 'Assembly'}</span>
          {busy && <span className="text-dim">compiling…</span>}
          <div className="ml-auto flex gap-1">
            {lang === 'python' && (
              <button className="btn" onClick={disPyc} title="Disassemble a .pyc in the current buffer">
                dis buffer .pyc
              </button>
            )}
            <button className="btn-primary" onClick={() => compile(true)} disabled={busy}>
              {lang === 'python' ? '.pyc → buffer' : 'Object file → buffer'}
            </button>
          </div>
        </div>
        {error ? (
          <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap text-warn">{error}</pre>
        ) : (
          <div className="min-h-0 flex-1">
            <CodeEditor value={output} readOnly language={lang === 'python' ? 'plaintext' : 'asm'} />
          </div>
        )}
        {info && (
          <pre className="max-h-24 shrink-0 overflow-auto border-t border-line bg-panel px-2 py-1 font-mono text-[11px] whitespace-pre-wrap text-dim">
            {info}
          </pre>
        )}
      </Panel>
    </Group>
  )
}
