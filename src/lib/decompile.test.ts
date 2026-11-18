import { describe, expect, it } from 'vitest'
import { exportName, filterFunctions, formatSize, isAutoNamed, splitFunctions } from './decompile'

const OUTPUT = `// Notes | AARCH64:LE:64:AppleSilicon | image base 100000000

// ---- entry @ 100003f20 ----

int entry(void)
{
  return FUN_100004000();
}

// ---- FUN_100004000 @ 100004000 ----

undefined8 FUN_100004000(void)
{
  return 0;
}

// ---- -[NoteStore save:] @ 100004100 ----

void _NoteStore_save_(long param_1)
{
  return;
}
`

describe('decompiler output', () => {
  it('finds every function marker with its line', () => {
    const fns = splitFunctions(OUTPUT)
    expect(fns).toEqual([
      { name: 'entry', addr: '100003f20', line: 3 },
      { name: 'FUN_100004000', addr: '100004000', line: 10 },
      { name: '-[NoteStore save:]', addr: '100004100', line: 17 },
    ])
    expect(OUTPUT.split('\n')[fns[2].line - 1]).toContain('NoteStore')
  })

  it('ignores ordinary comments and empty output', () => {
    expect(splitFunctions('')).toEqual([])
    expect(splitFunctions('// ---- not a marker\n/* decompilation failed */')).toEqual([])
  })

  it('filters by name, address and placeholder names', () => {
    const fns = splitFunctions(OUTPUT)
    expect(filterFunctions(fns, '', false)).toHaveLength(3)
    expect(filterFunctions(fns, 'notestore', false).map((f) => f.name)).toEqual(['-[NoteStore save:]'])
    expect(filterFunctions(fns, '4000', false).map((f) => f.name)).toEqual(['FUN_100004000'])
    expect(filterFunctions(fns, '', true).map((f) => f.name)).toEqual(['entry', '-[NoteStore save:]'])
  })

  it('recognises Ghidra placeholder names', () => {
    expect(isAutoNamed('FUN_00401000')).toBe(true)
    expect(isAutoNamed('thunk_FUN_1000')).toBe(true)
    expect(isAutoNamed('FUNCTION_TABLE')).toBe(false)
    expect(isAutoNamed('main')).toBe(false)
  })

  it('builds export names and sizes', () => {
    expect(exportName('/Applications/Notes.app/Contents/MacOS/Notes', 'arm64')).toBe('Notes-arm64.c')
    expect(exportName('libfoo.dylib')).toBe('libfoo.c')
    expect(exportName('')).toBe('decompiled.c')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(250 * 1024 * 1024)).toBe('250 MB')
  })
})
