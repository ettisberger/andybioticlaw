import type { ReactNode, ButtonHTMLAttributes, HTMLAttributes, ThHTMLAttributes } from 'react';

export function PageTitle({ children, subtitle }: { children: ReactNode; subtitle?: string }) {
  return (
    <div className="mb-5">
      <h1 className="text-xl font-semibold text-slate-100">{children}</h1>
      {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded border border-slate-700 bg-slate-800/50 p-4 ${className}`}
    >
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warn' | 'error' | 'accent';
}) {
  const toneClass = {
    neutral: 'bg-slate-700 text-slate-200',
    success: 'bg-emerald-900/70 text-emerald-300',
    warn: 'bg-amber-900/70 text-amber-200',
    error: 'bg-rose-900/70 text-rose-300',
    accent: 'bg-sky-900/70 text-sky-300',
  }[tone];
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${toneClass}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  variant = 'default',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'danger' | 'ghost' }) {
  const base =
    'inline-flex items-center rounded px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 transition';
  const variantClass = {
    default: 'bg-slate-700 text-slate-100 hover:bg-slate-600',
    danger: 'bg-rose-700 text-rose-50 hover:bg-rose-600',
    ghost: 'bg-transparent text-slate-300 hover:bg-slate-800',
  }[variant];
  return (
    <button {...rest} className={`${base} ${variantClass} ${rest.className ?? ''}`}>
      {children}
    </button>
  );
}

export function Table({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`overflow-auto rounded border border-slate-700 ${className}`}
    >
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  );
}

export function Th(props: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      {...props}
      className={`border-b border-slate-700 bg-slate-900/60 px-3 py-2 font-medium text-slate-400 ${props.className ?? ''}`}
    />
  );
}

export function Td(props: HTMLAttributes<HTMLTableCellElement>) {
  return <td {...props} className={`border-b border-slate-800 px-3 py-2 ${props.className ?? ''}`} />;
}

export function Empty({ message }: { message: string }) {
  return (
    <div className="rounded border border-dashed border-slate-700 bg-slate-800/30 px-4 py-6 text-center text-sm text-slate-500">
      {message}
    </div>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 rounded border border-rose-800 bg-rose-900/40 px-4 py-2 text-sm text-rose-200">
      {children}
    </div>
  );
}
