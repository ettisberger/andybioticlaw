import { Outlet, NavLink } from 'react-router-dom';

const NAV_ITEMS = [
  { to: '/overview', label: 'Overview' },
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
    <div className="flex h-screen">
      <aside className="w-56 shrink-0 border-r border-slate-700 bg-slate-900 px-4 py-5">
        <div className="mb-6">
          <div className="text-xs uppercase tracking-wider text-slate-500">service</div>
          <div className="text-lg font-semibold text-slate-100">andybioticlaw</div>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `rounded px-3 py-1.5 text-sm ${
                  isActive
                    ? 'bg-slate-700 text-slate-100'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto px-6 py-5">
        <Outlet />
      </main>
    </div>
  );
}
