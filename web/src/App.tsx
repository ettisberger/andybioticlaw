import { Outlet, NavLink } from 'react-router-dom';
import { Bot } from 'lucide-react';

const NAV_ITEMS = [
  { to: '/overview', label: 'Overview' },
  { to: '/stats', label: 'Stats' },
  { to: '/sessions', label: 'Sessions' },
  { to: '/schedules', label: 'Schedules' },
  { to: '/memory', label: 'Memory' },
  { to: '/skills', label: 'Skills' },
  { to: '/logs', label: 'Logs' },
  { to: '/config', label: 'Config' },
  { to: '/audit', label: 'Audit' },
];

export function App() {
  return (
    <div className="flex h-screen bg-bg">
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface px-4 py-6">
        <div className="mb-8 px-2">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-bg text-accent-ink">
              <Bot
                size={24}
                strokeWidth={2}
                aria-label="andybioticlaw"
              />
            </div>
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
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

        <div className="mt-auto pt-6">
          <div className="rounded-lg bg-surface-muted/60 px-3 py-2.5">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
              Tip
            </div>
            <div className="mt-1 text-xs leading-relaxed text-ink-dim">
              CLI still covers what the dashboard can't — e.g.{' '}
              <code className="rounded bg-surface px-1 py-0.5 text-[11px] text-ink">
                andybioticlaw schedule add
              </code>
              .
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-7xl px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
