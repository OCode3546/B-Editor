import { expect, test } from '@playwright/test'

/**
 * Desktop-only Decompile tab, driven against a fake Tauri backend: the init script stands in for
 * `window.__TAURI_INTERNALS__` and records every IPC call so the test can check what was sent.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const calls: { cmd: string; args: unknown; headers?: Record<string, string> }[] = []
    ;(window as unknown as { __calls: typeof calls }).__calls = calls
    const bundle = {
      path: '/Applications/Demo Notes.app',
      name: 'Demo Notes',
      identifier: 'com.example.notes',
      version: '2.4',
      build: '240',
      minOs: '14.0',
      executable: 'Demo Notes',
      info: [
        ['CFBundleIdentifier', 'com.example.notes'],
        ['CFBundleDocumentTypes', '[2 items]'],
      ],
      executables: [
        {
          path: '/Applications/Demo Notes.app/Contents/MacOS/Demo Notes',
          rel: 'Contents/MacOS/Demo Notes',
          kind: 'main',
          size: 182_000,
          archs: ['arm64'],
        },
        {
          path: '/Applications/Demo Notes.app/Contents/Frameworks/Sync.framework/Versions/A/Sync',
          rel: 'Contents/Frameworks/Sync.framework/Versions/A/Sync',
          kind: 'framework',
          size: 96_000,
          archs: ['x86_64', 'arm64'],
        },
      ],
      frameworks: ['Sparkle', 'Sync'],
      tech: ['AppKit / UIKit interface files (nib / storyboard)', 'Sparkle auto-updater'],
      resources: [
        ['Interface (nib / storyboard)', 3],
        ['Localizations', 12],
      ],
      files: 420,
      totalSize: 5_400_000,
      truncated: false,
    }
    const code = [
      '// Sync | x86:LE:64:default | image base 0',
      '',
      '// ---- _sync_start @ 00001000 ----',
      'int _sync_start(void) { return FUN_00001100(); }',
      '',
      '// ---- FUN_00001100 @ 00001100 ----',
      'int FUN_00001100(void) { return 0; }',
      '',
      '// ---- _sync_save @ 00001200 ----',
      'void _sync_save(long param_1) { return; }',
      '',
    ].join('\n')
    const replies: Record<string, unknown> = {
      get_recent: [],
      detect_tools: {
        clang: { path: null, version: null },
        rustc: { path: null, version: null },
        python: { path: null, version: null },
        ghidra: { path: '/opt/ghidra/support/analyzeHeadless', version: 'Ghidra 12.0' },
        javaHome: '/opt/jdk',
      },
      inspect_bundle: bundle,
      ghidra_decompile_file: { code, log: 'INFO  analysis done', seconds: 4.2 },
      'plugin:dialog|save': '/tmp/Sync-x86_64.c',
    }
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: () => 0,
      invoke: async (cmd: string, args: unknown, options?: { headers?: Record<string, string> }) => {
        calls.push({ cmd, args: args instanceof Uint8Array ? `<${args.length} bytes>` : args, headers: options?.headers })
        return replies[cmd] ?? null
      },
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Decompile', exact: true }).click()
})

const calls = (page: import('@playwright/test').Page, cmd: string) =>
  page.evaluate(
    (cmd) => (window as unknown as { __calls: { cmd: string; args: unknown; headers?: Record<string, string> }[] }).__calls.filter((c) => c.cmd === cmd),
    cmd,
  )

test('inspects an app bundle, decompiles one slice, filters and exports', async ({ page }) => {
  await page.getByRole('button', { name: 'App bundle' }).click()
  await page.getByLabel('App bundle path').fill('/Applications/Demo Notes.app')
  await page.getByLabel('App bundle path').press('Enter')

  const overview = page.getByLabel('Bundle overview')
  await expect(overview.getByRole('heading', { name: 'Demo Notes' })).toBeVisible()
  await expect(overview).toContainText('com.example.notes')
  await expect(overview).toContainText('2.4 (240)')
  await expect(overview).toContainText('Sparkle auto-updater')
  await expect(overview).toContainText('Localizations')
  expect(await calls(page, 'inspect_bundle')).toEqual([
    { cmd: 'inspect_bundle', args: { path: '/Applications/Demo Notes.app' } },
  ])

  // The main executable is preselected; pick the universal framework and its x86_64 slice instead.
  await expect(page.getByLabel('Decompile Contents/MacOS/Demo Notes')).toBeChecked()
  await page.getByLabel('Decompile Contents/Frameworks/Sync.framework/Versions/A/Sync').check()
  await expect(page.getByLabel('Architecture')).toHaveValue('arm64')
  await page.getByLabel('Architecture').selectOption('x86_64')

  await page.getByRole('button', { name: 'Decompile', exact: true }).last().click()
  await expect(page.getByText('3 of 3 functions')).toBeVisible()
  const [call] = await calls(page, 'ghidra_decompile_file')
  expect(call.args).toEqual({
    request: {
      path: '/Applications/Demo Notes.app/Contents/Frameworks/Sync.framework/Versions/A/Sync',
      arch: 'x86_64',
      processor: '',
      maxFunctions: 500,
    },
  })
  await expect(page.getByText('Sync · x86_64', { exact: true })).toBeVisible()

  const list = page.getByRole('list', { name: 'Functions' })
  await page.getByLabel('Filter functions').fill('save')
  await expect(page.getByText('1 of 3 functions')).toBeVisible()
  await expect(list.getByRole('button')).toHaveText(['_sync_save'])
  await page.getByLabel('Filter functions').fill('')
  await page.getByLabel('hide unnamed (FUN_…)').check()
  await expect(list.getByRole('button')).toHaveText(['_sync_start', '_sync_save'])
  await list.getByRole('button', { name: '_sync_save' }).click()

  await page.getByRole('button', { name: 'Log' }).click()
  await expect(page.getByText('INFO  analysis done')).toBeVisible()
  await page.getByRole('button', { name: 'Overview' }).click()
  await expect(overview).toBeVisible()

  await page.getByRole('button', { name: 'Export…' }).click()
  await expect.poll(async () => (await calls(page, 'write_file')).length).toBe(1)
  const [save] = await calls(page, 'plugin:dialog|save')
  expect(JSON.stringify(save.args)).toContain('Sync-x86_64.c')
  const [write] = await calls(page, 'write_file')
  expect(write.headers?.['x-path']).toBe(encodeURIComponent('/tmp/Sync-x86_64.c'))
})

test('buffer mode still works and bundle errors are shown', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Current buffer' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Ghidra imports the current buffer')).toBeVisible()

  await page.evaluate(() => {
    const t = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string) => Promise<unknown> } })
      .__TAURI_INTERNALS__
    const orig = t.invoke
    t.invoke = async (cmd: string, ...rest: unknown[]) => {
      if (cmd === 'inspect_bundle') throw '/tmp/nope has no readable Info.plist — is it an app bundle?'
      return (orig as (...a: unknown[]) => Promise<unknown>)(cmd, ...rest)
    }
  })
  await page.getByRole('button', { name: 'App bundle' }).click()
  await page.getByLabel('App bundle path').fill('/tmp/nope')
  await page.getByRole('button', { name: 'Inspect' }).click()
  await expect(page.getByText('has no readable Info.plist')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Decompile', exact: true }).last()).toBeDisabled()
})
