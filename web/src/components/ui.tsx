import type {
  ReactNode,
  ButtonHTMLAttributes,
  HTMLAttributes,
  ThHTMLAttributes,
} from 'react';

/**
 * PageTitle — top of each route. Balanced against the generous padding of
 * the main content area; subtitle sits one line below, muted.
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
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        {children}
      </h1>
      {subtitle && (
        <p className="mt-1.5 text-sm text-ink-dim">{subtitle}</p>
      )}
    </div>
  );
}

/**
 * Card — the main content container. White surface, hair-thin line,
 * generous inner padding. Lifts subtly off the warm canvas.
 */
export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-line bg-surface p-5 ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * Badge — pastel-filled pill with readable ink. The five tones map to
 * the semantic state palette defined in index.css.
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
 * Button — three variants. `default` is the safe bet; `primary` for the
 * single main CTA on a view; `danger` for destructive; `ghost` for
 * low-visual-weight actions that live inside a table row or card footer.
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
    'disabled:cursor-not-allowed disabled:opacity-50 ' +
    'focus:outline-none focus:ring-2 focus:ring-accent/40 focus:ring-offset-2 focus:ring-offset-surface';
  const variantClass = {
    default:
      'bg-surface border border-line text-ink hover:bg-surface-muted hover:border-line-strong',
    primary:
      'bg-accent text-white border border-accent hover:brightness-95',
    danger:
      'bg-error text-white border border-error hover:brightness-95',
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
 * Table — rounded container with soft row dividers. Header is a muted
 * wash with uppercase micro-labels.
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
      className={`overflow-auto rounded-xl border border-line bg-surface ${className}`}
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
 * Empty — dashed placeholder for "nothing yet" states. Friendlier than
 * a plain line of text, but visually quiet.
 */
export function Empty({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-surface-muted/40 px-6 py-10 text-center text-sm text-ink-faint">
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
    <div className="mb-4 rounded-xl border border-error/30 bg-error-bg px-4 py-3 text-sm text-error-ink">
      {children}
    </div>
  );
}

/**
 * InfoBanner — pastel-blue equivalent of ErrorBanner for soft notices
 * like "nothing to do here, but here's why".
 */
export function InfoBanner({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 rounded-xl border border-info/30 bg-info-bg px-4 py-3 text-sm text-info-ink">
      {children}
    </div>
  );
}

/**
 * StatNumber — large numeric display used in overview cards. Tight
 * letter-spacing pairs well with the pastel accents.
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
      <span className="text-3xl font-semibold tracking-tight text-ink">
        {value}
      </span>
      {suffix && <span className="text-sm text-ink-dim">{suffix}</span>}
    </div>
  );
}

/**
 * CardLabel — little uppercase label that goes above StatNumber or a
 * card's first line of content.
 */
export function CardLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
      {children}
    </div>
  );
}
