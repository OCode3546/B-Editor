import { expect, test, type Page } from '@playwright/test'

const editor = (page: Page, i: number) => page.locator('.monaco-editor .view-lines').nth(i)

async function replaceEditorText(page: Page, i: number, text: string) {
  await editor(page, i).click()
  await expect(page.locator('.monaco-editor').nth(i)).toHaveClass(/focused/)
  // Monaco can drop a shortcut sent right after focusing; repeat select-all + delete until empty.
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
    await expect(editor(page, i)).toHaveText('', { timeout: 300 })
  }).toPass({ timeout: 10_000 })
  await page.keyboard.type(text)
}

async function dropFile(page: Page, name: string, bytes: number[]) {
  await page.evaluate(
    ({ name, bytes }) => {
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array(bytes)], name))
      document.querySelector('#root > div')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }))
    },
    { name, bytes },
  )
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(editor(page, 1)).toContainText('48 65 6c 6c 6f')
})

test('text → bytes and bytes → text stay in sync', async ({ page }) => {
  await replaceEditorText(page, 0, 'Hé€')
  await expect(editor(page, 1)).toHaveText('48 c3 a9 e2 82 ac')

  await page.getByRole('button', { name: 'binary', exact: true }).click()
  await expect(editor(page, 1)).toContainText('01001000 11000011')

  await page.getByRole('button', { name: 'hex', exact: true }).click()
  await replaceEditorText(page, 1, '4f 4b 21')
  await expect(editor(page, 0)).toHaveText('OK!')
  await expect(page.getByText('3 bytes', { exact: true })).toBeVisible()
})

test('invalid bytes show an error instead of changing text', async ({ page }) => {
  await replaceEditorText(page, 1, '4f 4')
  await expect(page.getByText('✗ Odd number of hex digits')).toBeVisible()
})

test('hex editor: type, append, undo, inspector', async ({ page }) => {
  await page.getByRole('button', { name: 'New' }).click()
  await page.getByRole('button', { name: 'Hex Editor' }).click()
  await page.locator('[tabindex="0"].font-mono').click({ position: { x: 100, y: 10 } })
  await page.keyboard.type('01000000ff')
  await expect(page.locator('header')).toContainText('5 B')
  await page.keyboard.press('Home')
  // uint32 LE at offset 0 = 1
  const uint32 = page.locator('tr', { hasText: /^uint32/ }).locator('input')
  await expect(uint32).toHaveValue('1')
  await uint32.fill('4294967295')
  await uint32.press('Enter')
  await expect(page.locator('tr', { hasText: /^int32/ }).locator('input')).toHaveValue('-1')

  await page.locator('[tabindex="0"].font-mono').focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(uint32).toHaveValue('1')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('header')).toContainText('4 B')
})

test('data formats: JSON → MessagePack → YAML', async ({ page }) => {
  await page.getByRole('button', { name: 'Data Formats' }).click()
  await expect(page.getByText(/✓ \d+ bytes/)).toBeVisible()
  await expect(editor(page, 1)).toContainText('85 a4 6e 61 6d 65')
  await page.getByRole('button', { name: '⇄ Swap' }).click()
  await page.locator('select').nth(1).selectOption('yaml')
  await expect(editor(page, 1)).toContainText('name: binary-editor')
})

test('WAT → WASM → WAT round trip', async ({ page }) => {
  await page.getByRole('button', { name: 'Disassemble' }).click()
  await page.getByRole('button', { name: 'WASM ↔ WAT (wabt)' }).click()
  await expect(page.getByText(/✓ \d+ bytes/)).toBeVisible()
  await page.getByRole('button', { name: 'Use as buffer' }).click()
  await page.getByRole('button', { name: /Disassemble buffer/ }).click()
  await expect(editor(page, 0)).toContainText('(type $t0 (func (param i32 i32) (result i32)))')
})

test('capstone disassembles x86-64 and ARM64', async ({ page }) => {
  await page.getByRole('button', { name: 'Disassemble' }).click()
  await page.getByRole('button', { name: 'Machine code (Capstone)' }).click()
  await expect(page.getByText('8 instructions')).toBeVisible()
  await expect(page.locator('main')).toContainText('imul')
  await replaceEditorText(page, 0, 'c0 03 5f d6')
  await page.locator('select').first().selectOption('arm64')
  await expect(page.getByText('1 instructions')).toBeVisible()
  await expect(page.locator('main')).toContainText('ret')
})

test('executable view parses a dropped ELF', async ({ page }) => {
  // Minimal ELF64 x86-64: entry 0x401000, .text = push rbp; mov rbp,rsp; ret
  const b = new Array(0x200).fill(0)
  const put = (off: number, v: number, n: number) => {
    for (let i = 0; i < n; i++) b[off + i] = Number((BigInt(v) >> BigInt(8 * i)) & 0xffn)
  }
  ;[0x7f, 0x45, 0x4c, 0x46, 2, 1, 1].forEach((x, i) => (b[i] = x))
  put(16, 2, 2)
  put(18, 62, 2)
  put(24, 0x401000, 8)
  put(40, 0x100, 8)
  put(58, 64, 2)
  put(60, 3, 2)
  put(62, 2, 2)
  ;[...'\0.text\0.shstrtab\0'].forEach((c, i) => (b[0x80 + i] = c.charCodeAt(0)))
  ;[0x55, 0x48, 0x89, 0xe5, 0xc3].forEach((x, i) => (b[0x90 + i] = x))
  const sh = (i: number) => 0x100 + i * 64
  put(sh(1), 1, 4)
  put(sh(1) + 4, 1, 4)
  put(sh(1) + 8, 6, 8)
  put(sh(1) + 16, 0x401000, 8)
  put(sh(1) + 24, 0x90, 8)
  put(sh(1) + 32, 5, 8)
  put(sh(2), 7, 4)
  put(sh(2) + 4, 3, 4)
  put(sh(2) + 24, 0x80, 8)
  put(sh(2) + 32, 17, 8)

  await dropFile(page, 'tiny.elf', b)
  await page.getByRole('button', { name: 'Disassemble' }).click()
  await expect(page.getByText('ELF · x86-64 · 64-bit · LE')).toBeVisible()
  await expect(page.getByText('3 instructions')).toBeVisible()
  await expect(page.locator('main')).toContainText('push')
})

test('desktop-only tabs explain themselves in the browser', async ({ page }) => {
  await page.getByRole('button', { name: 'Compile', exact: true }).click()
  await expect(page.getByText('Compiling source code needs the desktop app')).toBeVisible()
  await page.getByRole('button', { name: 'Decompile', exact: true }).click()
  await expect(page.getByText('Decompiling with Ghidra needs the desktop app')).toBeVisible()
})
