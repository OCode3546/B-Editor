import { describe, expect, it } from 'vitest'
import { disassemble, isWasm, wasmToWat, watToWasm } from './disasm'

describe('wabt', () => {
  it('WAT -> WASM -> WAT', async () => {
    const wasm = await watToWasm('(module (func (export "f") (result i32) i32.const 42))')
    expect(isWasm(wasm)).toBe(true)
    const wat = await wasmToWat(wasm)
    expect(wat).toContain('i32.const 42')
    expect(wat).toContain('export "f"')
  })

  it('reports syntax errors', async () => {
    await expect(watToWasm('(module (func i32.bogus))')).rejects.toThrow()
  })
})

describe('capstone', () => {
  it('x86-64', async () => {
    const insns = await disassemble(new Uint8Array([0x55, 0x48, 0x89, 0xe5, 0xc3]), 'x86-64', 0x1000n)
    expect(insns.map((i) => i.mnemonic)).toEqual(['push', 'mov', 'ret'])
    expect(insns[1].address).toBe(0x1001n)
  })

  it('arm64', async () => {
    const insns = await disassemble(new Uint8Array([0xc0, 0x03, 0x5f, 0xd6]), 'arm64', 0n)
    expect(insns[0].mnemonic).toBe('ret')
  })

  it('emits .byte for undecodable bytes and continues', async () => {
    const insns = await disassemble(new Uint8Array([0x06, 0xc3]), 'x86-64', 0n)
    expect(insns[0].mnemonic).toBe('.byte')
    expect(insns[1].mnemonic).toBe('ret')
  })
})
