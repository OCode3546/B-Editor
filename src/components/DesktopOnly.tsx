import type { ReactNode } from 'react'
import { isDesktop } from '../platform'

export function DesktopOnly({ feature, children }: { feature: string; children: ReactNode }) {
  if (isDesktop) return <>{children}</>
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded border border-line bg-panel p-5 text-center">
        <p className="mb-2 font-semibold text-fg">{feature} needs the desktop app</p>
        <p className="text-dim">
          It runs local tools (clang, rustc, Python, Ghidra) as separate processes, which a browser cannot do. Start
          it with <code className="text-accent">npm run desktop</code>.
        </p>
      </div>
    </div>
  )
}
