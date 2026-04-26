import { Outlet, NavLink } from 'react-router-dom';
import { Bot } from 'lucide-react';
import { ThemeToggle } from './components/theme';

const NAV_ITEMS = [
  { to: '/overview', label: 'Overview' },
  { to: '/stats', label: 'Stats' },
  { to: '/sessions', label: 'Sessions' },
  { to: '/schedules', label: 'Schedules' },
  { to: '/memory', label: 'Memory' },
  { to: '/notes', label: 'Notes' },
  { to: '/skills', label: 'Skills' },
  { to: '/logs', label: 'Logs' },
  { to: '/config', label: 'Config' },
  { to: '/audit', label: 'Audit' },
];

export function App() {
  return (
    <div className="flex h-screen">
      {/* Glass sidebar — sits on top of the gradient mesh. Uses a
          slightly stronger blur than content cards so nav stays readable
          even over busy backdrops. */}
      <aside className="glass-strong glass-highlight m-3 flex w-56 shrink-0 flex-col rounded-2xl px-3 py-5">
        <div className="mb-8 px-2">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-bg text-accent-ink">
              <Bot size={22} strokeWidth={2} aria-label="andybioticlaw" />
            </div>
            <div>
              <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">
                service
              </div>
              <div className="text-sm font-semibold text-ink">
                andybioticlaw
              </div>
            </div>
          </div>
        </div>

        <nav className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `relative rounded-lg px-3 py-2 text-sm font-medium ${
                  isActive
                    ? 'bg-accent-bg text-accent-ink'
                    : 'text-ink-dim hover:bg-accent-bg/50 hover:text-ink'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-accent" />
                  )}
                  {item.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto space-y-3 pt-6">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">
              theme
            </div>
            <ThemeToggle />
          </div>
          <div className="rounded-2xl border border-line/60 bg-surface/40 px-3 py-2.5 backdrop-blur-sm">
            <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">
              Tip
            </div>
            <div className="mt-1 text-xs leading-relaxed text-ink-dim">
              CLI still covers what the dashboard can&apos;t — e.g.{' '}
              <code className="rounded bg-surface px-1 py-0.5 text-[11px] text-ink">
                andybioticlaw schedule add
              </code>
              .
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <div className="fade-in mx-auto max-w-7xl px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
