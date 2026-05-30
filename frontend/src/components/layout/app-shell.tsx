import { Sidebar } from './sidebar'

interface Props {
  children: React.ReactNode
}

export function AppShell({ children }: Props) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-auto bg-background">
        {children}
      </main>
    </div>
  )
}
