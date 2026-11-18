import { useSyncExternalStore } from 'react'
import { desktop, isDesktop } from './platform'

/**
 * Single shared document buffer. Every edit is a splice so undo/redo works the
 * same for the hex editor, the text view and the converters.
 */
export interface DocState {
  bytes: Uint8Array
  rev: number
  name: string
  /** Absolute path (desktop only). */
  path: string | null
  recent: string[]
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
}

interface Patch {
  offset: number
  removed: Uint8Array
  inserted: Uint8Array
}

type FileHandle = {
  name: string
  getFile(): Promise<File>
  createWritable(): Promise<{ write(d: BufferSource): Promise<void>; close(): Promise<void> }>
}

const MAX_HISTORY = 1000
let bytes: Uint8Array<ArrayBuffer> = new TextEncoder().encode('Hello, binary!\n') as Uint8Array<ArrayBuffer>
let rev = 0
let name = 'untitled.bin'
let dirty = false
let handle: FileHandle | null = null
let path: string | null = null
let recent: string[] = []
const undoStack: Patch[] = []
const redoStack: Patch[] = []
const listeners = new Set<() => void>()
let snapshot: DocState = makeSnapshot()

function makeSnapshot(): DocState {
  return {
    bytes,
    rev,
    name,
    path,
    recent,
    dirty,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  }
}

function emit() {
  rev++
  snapshot = makeSnapshot()
  listeners.forEach((l) => l())
}

function applyRaw(offset: number, del: number, ins: Uint8Array): Uint8Array {
  const removed = bytes.slice(offset, offset + del)
  if (del === ins.length) {
    bytes.set(ins, offset)
  } else {
    const next = new Uint8Array(bytes.length - del + ins.length)
    next.set(bytes.subarray(0, offset))
    next.set(ins, offset)
    next.set(bytes.subarray(offset + del), offset + ins.length)
    bytes = next
  }
  return removed
}

export const doc = {
  get: () => snapshot,

  subscribe(l: () => void) {
    listeners.add(l)
    return () => listeners.delete(l)
  },

  /** Replace `del` bytes at `offset` with `ins`. Returns the new revision. */
  splice(offset: number, del: number, ins: Uint8Array = new Uint8Array(), opts: { merge?: boolean } = {}): number {
    offset = Math.max(0, Math.min(offset, bytes.length))
    del = Math.max(0, Math.min(del, bytes.length - offset))
    if (del === 0 && ins.length === 0) return rev
    const removed = applyRaw(offset, del, ins)
    const prev = undoStack[undoStack.length - 1]
    if (opts.merge && prev && prev.offset === offset && prev.inserted.length === del) {
      // Fold a follow-up overwrite (e.g. second hex nibble) into the previous edit.
      prev.inserted = ins.slice()
    } else {
      undoStack.push({ offset, removed, inserted: ins.slice() })
    }
    if (undoStack.length > MAX_HISTORY) undoStack.shift()
    redoStack.length = 0
    dirty = true
    emit()
    return rev
  },

  /** Replace the whole buffer (undoable). Returns the new revision. */
  replace(next: Uint8Array): number {
    return doc.splice(0, bytes.length, next)
  },

  undo(): { offset: number } | null {
    const p = undoStack.pop()
    if (!p) return null
    applyRaw(p.offset, p.inserted.length, p.removed)
    redoStack.push(p)
    dirty = true
    emit()
    return { offset: p.offset }
  },

  redo(): { offset: number } | null {
    const p = redoStack.pop()
    if (!p) return null
    applyRaw(p.offset, p.removed.length, p.inserted)
    undoStack.push(p)
    dirty = true
    emit()
    return { offset: p.offset }
  },

  load(data: Uint8Array, fileName: string, h: FileHandle | null = null, filePath: string | null = null) {
    bytes = new Uint8Array(data)
    name = fileName
    handle = h
    path = filePath
    dirty = false
    undoStack.length = 0
    redoStack.length = 0
    emit()
  },

  async open() {
    if (isDesktop) {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const picked = await open({ multiple: false, directory: false })
      if (typeof picked === 'string') await doc.openPath(picked)
      return
    }
    const w = window as unknown as {
      showOpenFilePicker?: () => Promise<FileHandle[]>
    }
    if (w.showOpenFilePicker) {
      try {
        const [h] = await w.showOpenFilePicker()
        const f = await h.getFile()
        doc.load(new Uint8Array(await f.arrayBuffer()), f.name, h)
      } catch (e) {
        if ((e as Error).name !== 'AbortError') throw e
      }
      return
    }
    const input = document.createElement('input')
    input.type = 'file'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (f) doc.load(new Uint8Array(await f.arrayBuffer()), f.name)
    }
    input.click()
  },

  /** Desktop: open by absolute path (dialog, recent list). */
  async openPath(p: string) {
    const data = await desktop.readFile(p)
    doc.load(data, baseName(p), null, p)
    await doc.remember(p)
  },

  async remember(p: string) {
    recent = await desktop.addRecent(p)
    emit()
  },

  async loadRecent() {
    if (!isDesktop) return
    recent = await desktop.getRecent()
    emit()
  },

  async openFile(f: File) {
    doc.load(new Uint8Array(await f.arrayBuffer()), f.name)
  },

  async save(as = false) {
    const w = window as unknown as {
      showSaveFilePicker?: (o: { suggestedName: string }) => Promise<FileHandle>
    }
    if (isDesktop) {
      let target = as ? null : path
      if (!target) {
        const { save } = await import('@tauri-apps/plugin-dialog')
        target = await save({ defaultPath: path ?? name })
        if (!target) return
      }
      await desktop.writeFile(target, bytes)
      path = target
      name = baseName(target)
      dirty = false
      emit()
      await doc.remember(target)
      return
    }
    try {
      if ((as || !handle) && w.showSaveFilePicker) {
        handle = await w.showSaveFilePicker({ suggestedName: name })
        name = handle.name
      }
      if (handle) {
        const out = await handle.createWritable()
        await out.write(bytes)
        await out.close()
      } else {
        download(bytes, name)
      }
      dirty = false
      emit()
    } catch (e) {
      if ((e as Error).name !== 'AbortError') throw e
    }
  },

  newFile() {
    doc.load(new Uint8Array(), 'untitled.bin')
  },
}

const baseName = (p: string) => p.split(/[\\/]/).pop() || p

export function download(data: Uint8Array, fileName: string) {
  const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>]))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function useDoc(): DocState {
  return useSyncExternalStore(doc.subscribe, doc.get)
}
