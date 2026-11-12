import Link from "next/link";
import type { ReactNode } from "react";

export function PageTitle({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {back && <Link href={back.href} className="mb-1 inline-block text-sm text-slate-500 hover:text-slate-800">← {back.label}</Link>}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-slate-500">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = "", title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
          {actions}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone = "slate" }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "slate" | "green" | "red" | "amber" }) {
  const toneCls = { slate: "text-slate-900", green: "text-green-700", red: "text-red-700", amber: "text-amber-700" }[tone];
  return (
    <div className="card px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneCls}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

const g7cls: Record<number, string> = {
  1: "bg-red-100 text-red-800", 2: "bg-red-100 text-red-800", 3: "bg-orange-100 text-orange-800",
  4: "bg-amber-100 text-amber-800", 5: "bg-lime-100 text-lime-800", 6: "bg-green-100 text-green-800", 7: "bg-emerald-100 text-emerald-800",
};
export function Grade7({ value, overridden, muted }: { value: number | null | undefined; overridden?: boolean; muted?: boolean }) {
  if (value == null) return <span className="text-slate-300">—</span>;
  return (
    <span title={overridden ? "override" : undefined} className={`inline-flex min-w-[1.75rem] justify-center rounded-md px-1.5 py-0.5 text-sm font-semibold tabular-nums ${muted ? "bg-slate-100 text-slate-500" : g7cls[value] ?? ""} ${overridden ? "ring-2 ring-violet-400" : ""}`}>
      {value}
    </span>
  );
}
export function Grade5({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-slate-300">—</span>;
  const cls = value >= 5 ? "text-emerald-700" : value === 4 ? "text-lime-700" : value === 3 ? "text-amber-700" : "text-red-700";
  return <span className={`text-sm font-semibold tabular-nums ${cls}`}>{value}</span>;
}
export function Level({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-slate-300">·</span>;
  const cls = value >= 7 ? "text-emerald-700" : value >= 5 ? "text-green-700" : value >= 3 ? "text-amber-700" : "text-red-700";
  return <span className={`font-medium tabular-nums ${cls}`}>{value}</span>;
}

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "green" | "red" | "amber" | "blue" | "violet" }) {
  const cls = {
    slate: "bg-slate-100 text-slate-700", green: "bg-green-100 text-green-800", red: "bg-red-100 text-red-800",
    amber: "bg-amber-100 text-amber-800", blue: "bg-blue-100 text-blue-800", violet: "bg-violet-100 text-violet-800",
  }[tone];
  return <span className={`badge ${cls}`}>{children}</span>;
}

export function Notice({ children, tone = "blue" }: { children: ReactNode; tone?: "blue" | "amber" | "green" | "red" }) {
  const cls = { blue: "border-blue-200 bg-blue-50 text-blue-900", amber: "border-amber-200 bg-amber-50 text-amber-900", green: "border-green-200 bg-green-50 text-green-900", red: "border-red-200 bg-red-50 text-red-900" }[tone];
  return <div className={`mb-4 rounded-lg border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

export function Tabs({ items }: { items: { href: string; label: ReactNode; active: boolean; title?: string }[] }) {
  return (
    <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
      {items.map((i) => (
        <Link key={i.href} href={i.href} title={i.title} aria-current={i.active ? "page" : undefined} className={`-mb-px rounded-t-md border-b-2 px-3 py-1.5 text-sm font-medium ${i.active ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
          {i.label}
        </Link>
      ))}
    </div>
  );
}
