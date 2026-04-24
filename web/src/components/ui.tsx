import type {
  ReactNode,
  ButtonHTMLAttributes,
  HTMLAttributes,
  ThHTMLAttributes,
} from 'react';

/**
 * PageTitle — top of each route. Slightly larger than before, tighter
 * tracking for the glass aesthetic.
 */
export function PageTitle({
  children,
  subtitle,
}: {
  children: ReactNode;
  subtitle?: string;
}) {
  return (
    <div className="mb-8">
      <h1 className="text-[26px] font-semibold tracking-tight text-ink">
        {children}
      </h1>
      {subtitle && (
        <p className="mt-1.5 text-sm text-ink-dim">{subtitle}</p>
      )}
    </div>
  );
}

/**
 * Card — the default content container. Translucent surface with
 * backdrop blur + hairline border + soft ambient shadow. Reads as a
 * floating glass panel against the mesh gradient backdrop.
 *
 * Pass `tone="strong"` for the rare spot (e.g. sidebar, sticky header)
 * that should feel more opaque.
 */
export function Card({
  children,
  className = '',
  tone = 'default',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'default' | 'strong';
}) {
  const toneClass = tone === 'strong' ? 'glass-strong' : 'glass';
  return (
    <div
      className={`glass-highlight rounded-2xl p-5 ${toneClass} ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * Badge — pastel-filled pill with readable ink. Six tones mapped to
 * the semantic palette in index.css.
 */
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warn' | 'error' | 'accent' | 'info';
}) {
  const toneClass = {
    neutral: 'bg-surface-muted text-ink-dim',
    success: 'bg-success-bg text-success-ink',
    warn: 'bg-warn-bg text-warn-ink',
    error: 'bg-error-bg text-error-ink',
    accent: 'bg-accent-bg text-accent-ink',
    info: 'bg-info-bg text-info-ink',
  }[tone];
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${toneClass}`}
    >
      {children}
    </span>
  );
}

/**
 * Button — four variants. `default` is the glass-native button (works
 * on any background); `primary` for main CTAs; `danger` for destructive;
 * `ghost` for row-level actions that shouldn't grab attention.
 */
export function Button({
  children,
  variant = 'default',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
}) {
  const base =
    'inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-sm font-medium ' +
    'active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 ' +
    'focus:outline-none focus:ring-2 focus:ring-accent/40 focus:ring-offset-2 focus:ring-offset-bg';
  const variantClass = {
    default:
      'border border-line bg-surface/60 text-ink backdrop-blur-sm hover:bg-surface hover:border-line-strong',
    primary:
      'border border-accent bg-accent text-white hover:brightness-95 shadow-sm',
    danger:
      'border border-error bg-error text-white hover:brightness-95 shadow-sm',
    ghost:
      'bg-transparent text-ink-dim hover:bg-accent-bg hover:text-accent-ink',
  }[variant];
  return (
    <button {...rest} className={`${base} ${variantClass} ${rest.className ?? ''}`}>
      {children}
    </button>
  );
}

/**
 * Table — glass container with soft row dividers. Header is a muted
 * translucent wash with uppercase micro-labels.
 */
export function Table({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`glass glass-highlight overflow-auto rounded-2xl ${className}`}
    >
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  );
}

export function Th(props: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      {...props}
      className={`border-b border-line bg-surface-muted/60 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint ${props.className ?? ''}`}
    />
  );
}

export function Td(props: HTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      {...props}
      className={`border-b border-line/60 px-4 py-3 align-middle ${props.className ?? ''}`}
    />
  );
}

/**
 * Empty — dashed-outline placeholder for "nothing yet" states. Quiet,
 * friendly, glass-tinted.
 */
export function Empty({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-surface/30 px-6 py-10 text-center text-sm text-ink-faint backdrop-blur-sm">
      {message}
    </div>
  );
}

/**
 * ErrorBanner — dusty-rose fill with soft outline. Loud enough to notice,
 * quiet enough not to jar.
 */
export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 rounded-2xl border border-error/30 bg-error-bg/70 px-4 py-3 text-sm text-error-ink backdrop-blur-sm">
      {children}
    </div>
  );
}

/**
 * InfoBanner — pastel-blue equivalent of ErrorBanner for soft notices.
 */
export function InfoBanner({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 rounded-2xl border border-info/30 bg-info-bg/70 px-4 py-3 text-sm text-info-ink backdrop-blur-sm">
      {children}
    </div>
  );
}

/**
 * StatNumber — large numeric display used in overview / hero cards.
 * Tabular nums so aligned rows of numbers don't jitter as digits change.
 */
export function StatNumber({
  value,
  suffix,
  className = '',
}: {
  value: ReactNode;
  suffix?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-baseline gap-1.5 ${className}`}>
      <span className="text-3xl font-semibold tracking-tight text-ink tabular-nums">
        {value}
      </span>
      {suffix && <span className="text-sm text-ink-dim">{suffix}</span>}
    </div>
  );
}

/**
 * CardLabel — little uppercase label above StatNumber.
 */
export function CardLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
      {children}
    </div>
  );
}

/**
 * LiveDot — pulsing indicator for "something is happening right now".
 * Standardised here so every page uses the same visual signal.
 */
export function LiveDot({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const s = size === 'md' ? 'h-2.5 w-2.5' : 'h-2 w-2';
  return (
    <span className={`relative flex ${s}`}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
      <span className={`relative inline-flex ${s} rounded-full bg-accent`} />
    </span>
  );
}
