import { useEffect, useState } from 'react'
import { desktop, errorText, type Settings, type Tools } from '../platform'

const FIELDS: [keyof Settings, string, string][] = [
  ['clang', 'clang', 'auto-detect'],
  ['rustc', 'rustc', 'auto-detect'],
  ['python', 'Python', 'auto-detect'],
  ['ghidraDir', 'Ghidra folder', 'auto-detect (contains support/analyzeHeadless)'],
  ['javaHome', 'JDK home (Ghidra)', 'auto-detect'],
]

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [tools, setTools] = useState<Tools | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = () => desktop.detectTools().then(setTools).catch((e) => setError(errorText(e)))

  useEffect(() => {
    desktop.getSettings().then(setSettings).catch((e) => setError(errorText(e)))
    refresh()
  }, [])

  const save = async () => {
    if (!settings) return
    try {
      await desktop.saveSettings(settings)
      await refresh()
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const detected = (k: keyof Settings): string | null => {
    if (!tools) return null
    switch (k) {
      case 'clang':
        return tools.clang.version ?? 'not found'
      case 'rustc':
        return tools.rustc.version ?? 'not found'
      case 'python':
        return tools.python.version ?? 'not found'
      case 'ghidraDir':
        return tools.ghidra.path ? `${tools.ghidra.version ?? 'Ghidra'} — ${tools.ghidra.path}` : 'not found'
      case 'javaHome':
        return tools.javaHome ?? 'not found'
      default:
        return null
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <div
        className="w-[640px] max-w-[95vw] rounded border border-line bg-panel p-4 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2 className="mb-3 text-sm font-semibold">Settings</h2>
        {!settings ? (
          <p className="text-dim">{error ?? 'Loading…'}</p>
        ) : (
          <div className="flex flex-col gap-3 text-xs">
            {FIELDS.map(([k, label, placeholder]) => (
              <label key={k} className="flex flex-col gap-1">
                <span className="text-dim">{label}</span>
                <input
                  className="field font-mono"
                  placeholder={placeholder}
                  value={settings[k] as string}
                  onChange={(e) => setSettings({ ...settings, [k]: e.target.value })}
                />
                <span className={detected(k) === 'not found' ? 'text-warn' : 'text-ok'}>{detected(k)}</span>
              </label>
            ))}
            <div className="flex gap-4">
              <label className="flex flex-col gap-1">
                <span className="text-dim">Compiler timeout (s)</span>
                <input
                  className="field w-24"
                  type="number"
                  min={5}
                  value={settings.toolTimeoutSecs}
                  onChange={(e) => setSettings({ ...settings, toolTimeoutSecs: Number(e.target.value) })}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-dim">Ghidra timeout (s)</span>
                <input
                  className="field w-24"
                  type="number"
                  min={30}
                  value={settings.ghidraTimeoutSecs}
                  onChange={(e) => setSettings({ ...settings, ghidraTimeoutSecs: Number(e.target.value) })}
                />
              </label>
            </div>
            {error && <p className="text-warn">{error}</p>}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn-primary" onClick={save} disabled={!settings}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
