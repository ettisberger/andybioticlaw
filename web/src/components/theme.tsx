import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { Moon, Sun } from 'lucide-react';

type Mode = 'light' | 'dark';
const STORAGE_KEY = 'abl_theme_mode';

interface ThemeContextValue {
  mode: Mode;
  toggle: () => void;
  set: (m: Mode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Resolve the initial theme synchronously, before React paints, so the
 * first frame already has the right colors. Priority:
 *   1. Explicit user choice stored in localStorage (the toggle).
 *   2. Light (default — chosen over system-follow because the dashboard
 *      is a warm-palette tool; dark is opt-in via the toggle).
 *
 * Called once at module init — the returned mode is the source of truth
 * for the first render. Subsequent changes go through React state.
 */
function readInitialMode(): Mode {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // localStorage can throw in private browsing / embedded contexts —
    // fall through to the default.
  }
  return 'light';
}

function applyMode(mode: Mode) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', mode);
  // Hint to user-agent for form controls, scrollbars, native widgets.
  document.documentElement.style.colorScheme = mode;
}

// Apply at module load so the first paint is already themed — avoids a
// flash of white on initial boot in dark mode.
applyMode(readInitialMode());

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>(readInitialMode);

  useEffect(() => {
    applyMode(mode);
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* fine — theme just won't persist */
    }
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((m) => (m === 'dark' ? 'light' : 'dark'));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, toggle, set: setMode }),
    [mode, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

/**
 * Sun/moon toggle. Renders the icon for the mode you'd SWITCH TO — sun
 * in dark mode, moon in light mode — which matches the user's mental
 * model of "tap this to go there".
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { mode, toggle } = useTheme();
  const Icon = mode === 'dark' ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line/60 bg-surface/50 text-ink-dim backdrop-blur-md hover:bg-surface hover:text-ink ${className}`}
    >
      <Icon size={16} strokeWidth={2} />
    </button>
  );
}
