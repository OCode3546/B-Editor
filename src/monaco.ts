// Bundle Monaco locally (no CDN) so the app works offline and inside Tauri later.
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/languages/features/json/json.worker?worker'

self.MonacoEnvironment = {
  getWorker(_id, label) {
    return label === 'json' ? new jsonWorker() : new editorWorker()
  },
}

monaco.languages.register({ id: 'wat' })
monaco.languages.setMonarchTokensProvider('wat', {
  keywords: [
    'module', 'func', 'param', 'result', 'local', 'global', 'export', 'import', 'memory',
    'data', 'table', 'elem', 'type', 'mut', 'start', 'block', 'loop', 'if', 'then', 'else',
    'end', 'br', 'br_if', 'br_table', 'return', 'call', 'call_indirect', 'drop', 'select',
  ],
  tokenizer: {
    root: [
      [/;;.*$/, 'comment'],
      [/\(;/, 'comment', '@comment'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/\$[\w.$@!#%&*+\-/:<=>?^`|~']+/, 'variable'],
      [/\b(i32|i64|f32|f64|v128|funcref|externref)\b(\.[\w_]+)?/, 'type'],
      [/-?(0x[0-9a-fA-F_]+|\d[\d_]*(\.\d+)?)/, 'number'],
      [/[a-z_][\w.]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
    ],
    comment: [
      [/;\)/, 'comment', '@pop'],
      [/./, 'comment'],
    ],
  },
})

monaco.languages.register({ id: 'bytes' })
monaco.languages.setMonarchTokensProvider('bytes', {
  tokenizer: {
    root: [
      [/\b[01]{8}\b/, 'number'],
      [/\b[0-9a-fA-F]{2}\b/, 'number.hex'],
      [/\d+/, 'number'],
    ],
  },
})

monaco.languages.register({ id: 'asm' })
monaco.languages.setMonarchTokensProvider('asm', {
  tokenizer: {
    root: [
      [/(;|#|\/\/|@).*$/, 'comment'],
      [/^\s*[\w.$]+:/, 'type'],
      [/^\s*\.[\w]+/, 'keyword'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/^\s*[a-z][\w.]*/, 'tag'],
      [/\b(0x[0-9a-fA-F]+|\d+)\b/, 'number'],
      [/%?\b[re]?[abcd]x\b|%?\b[re]?[sd]i\b|%?\b[re]?[sb]p\b|%?\br\d+[dwb]?\b|\b[wx]\d+\b|\bsp\b/, 'variable'],
    ],
  },
})

loader.config({ monaco })
