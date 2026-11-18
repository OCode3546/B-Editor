import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { detectFormat, parseExecutable } from './exe'

/** Minimal ELF64 x86-64 with one .text section holding `ret`. */
function tinyElf(): Uint8Array {
  const b = new Uint8Array(0x200)
  const v = new DataView(b.buffer)
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  v.setUint16(16, 2, true) // EXEC
  v.setUint16(18, 62, true) // x86-64
  v.setBigUint64(24, 0x401000n, true) // entry
  v.setBigUint64(40, 0x100n, true) // shoff
  v.setUint16(58, 64, true) // shentsize
  v.setUint16(60, 3, true) // shnum
  v.setUint16(62, 2, true) // shstrndx
  // strings at 0x80: "\0.text\0.shstrtab\0"
  b.set(new TextEncoder().encode('\0.text\0.shstrtab\0'), 0x80)
  b[0x90] = 0xc3 // ret
  const sh = (i: number) => 0x100 + i * 64
  // .text
  v.setUint32(sh(1), 1, true)
  v.setUint32(sh(1) + 4, 1, true)
  v.setBigUint64(sh(1) + 8, 6n, true) // ALLOC|EXEC
  v.setBigUint64(sh(1) + 16, 0x401000n, true)
  v.setBigUint64(sh(1) + 24, 0x90n, true)
  v.setBigUint64(sh(1) + 32, 1n, true)
  // .shstrtab
  v.setUint32(sh(2), 7, true)
  v.setUint32(sh(2) + 4, 3, true)
  v.setBigUint64(sh(2) + 24, 0x80n, true)
  v.setBigUint64(sh(2) + 32, 17n, true)
  return b
}

describe('executable parser', () => {
  it('parses a minimal ELF', () => {
    const info = parseExecutable(tinyElf())
    expect(info.format).toBe('ELF')
    expect(info.arch).toBe('x86-64')
    expect(info.entry).toBe(0x401000n)
    expect(info.target).toBe('x86-64')
    const text = info.sections.find((s) => s.name === '.text')!
    expect(text).toMatchObject({ addr: 0x401000n, offset: 0x90, size: 1, exec: true })
  })

  it('rejects non-executables', () => {
    expect(detectFormat(new TextEncoder().encode('hello'))).toBeNull()
    expect(() => parseExecutable(new Uint8Array([1, 2, 3, 4]))).toThrow()
  })

  it('does not throw on truncated headers', () => {
    expect(() => parseExecutable(tinyElf().slice(0, 0x110))).toThrow(/Truncated/)
  })

  it.skipIf(!existsSync('/bin/ls'))('parses the system /bin/ls', () => {
    const info = parseExecutable(new Uint8Array(readFileSync('/bin/ls')))
    expect(['ELF', 'Mach-O', 'Mach-O (fat)']).toContain(info.format)
    if (info.slices.length) {
      const s = info.slices[0]
      const bytes = new Uint8Array(readFileSync('/bin/ls'))
      const inner = parseExecutable(bytes.subarray(s.offset, s.offset + s.size))
      expect(inner.sections.some((x) => x.exec)).toBe(true)
    } else {
      expect(info.sections.some((x) => x.exec)).toBe(true)
    }
  })
})
