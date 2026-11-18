import Editor, { type OnMount } from '@monaco-editor/react'
import { useEffect, useRef } from 'react'

type MonacoEditor = Parameters<OnMount>[0]

interface Props {
  value: string
  onChange?: (v: string) => void
  language?: string
  readOnly?: boolean
  wordWrap?: boolean
  /** Scrolls this 1-based line to the top. Pass a new object to jump again to the same line. */
  reveal?: { line: number } | null
}

export function CodeEditor({ value, onChange, language = 'plaintext', readOnly, wordWrap, reveal }: Props) {
  const ref = useRef<MonacoEditor | null>(null)

  const jump = (ed: MonacoEditor, line: number) => {
    ed.revealLineNearTop(line)
    ed.setPosition({ lineNumber: line, column: 1 })
    ed.focus()
  }

  useEffect(() => {
    if (reveal && ref.current) jump(ref.current, reveal.line)
  }, [reveal])

  return (
    <Editor
      theme="vs-dark"
      language={language}
      value={value}
      onChange={(v) => onChange?.(v ?? '')}
      onMount={(ed) => {
        ref.current = ed
        if (reveal) jump(ed, reveal.line)
      }}
      options={{
        readOnly,
        // Experimental in Monaco and unsupported by WebKit (Tauri on macOS): use the classic textarea everywhere.
        editContext: false,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
        wordWrap: wordWrap ? 'on' : 'off',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        renderWhitespace: 'selection',
        unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: true },
        tabSize: 2,
      }}
    />
  )
}
