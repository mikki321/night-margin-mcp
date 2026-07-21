import { Dashboard } from '@/components/dashboard'

export default function Page() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-6 sm:px-6">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-primary" aria-hidden="true" />
            <h1 className="text-lg font-semibold">Night Margin</h1>
          </div>
          <p className="text-sm text-muted-foreground text-pretty">
            Every pricing decision net of turnover costs — the metric that matters is{' '}
            <strong className="font-medium text-foreground">net per available night</strong>, not
            gross revenue. Synthetic demo portfolio, 8 properties, calendar year 2026.
          </p>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <Dashboard />
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-8 sm:px-6">
        <p className="text-xs text-muted-foreground text-pretty">
          Same engine as the night-margin-mcp server for Claude. All data is synthetic — no real
          customer or property data.
        </p>
      </footer>
    </div>
  )
}
