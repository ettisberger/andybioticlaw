import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { App } from './App';
import { ThemeProvider } from './components/theme';
import { OverviewPage } from './pages/OverviewPage';
import { SessionsPage } from './pages/SessionsPage';
import { SessionDetailPage } from './pages/SessionDetailPage';
import { SchedulesPage } from './pages/SchedulesPage';
import { AgentsPage } from './pages/AgentsPage';
import { MemoryPage } from './pages/MemoryPage';
import { NotesPage } from './pages/NotesPage';
import { PoliciesPage } from './pages/PoliciesPage';
import { SkillsPage } from './pages/SkillsPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { LogsPage } from './pages/LogsPage';
import { ConfigPage } from './pages/ConfigPage';
import { AuditPage } from './pages/AuditPage';
import './index.css';

// Lazy-load StatsPage so Recharts (the heaviest dep in this app) ships in
// its own chunk, only fetched when someone actually opens /stats. Keeps
// the initial Overview load light.
const StatsPage = lazy(() =>
  import('./pages/StatsPage').then((m) => ({ default: m.StatsPage })),
);

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
        <Route element={<App />}>
          <Route index element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route
            path="/stats"
            element={
              <Suspense fallback={<div className="text-ink-dim">loading charts…</div>}>
                <StatsPage />
              </Suspense>
            }
          />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/sessions/:id" element={<SessionDetailPage />} />
          <Route path="/schedules" element={<SchedulesPage />} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/notes" element={<NotesPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/policies" element={<PoliciesPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/config" element={<ConfigPage />} />
          <Route path="/audit" element={<AuditPage />} />
        </Route>
      </Routes>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
