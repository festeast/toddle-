"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Главное меню. Активный пункт определяется в браузере: общий layout при переходах между страницами
 * не перерисовывается на сервере, поэтому серверная подсветка «застревала» на первой открытой странице.
 */
export function NavLinks({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  // страницы заданий относятся к разделу курсов
  const section = path.startsWith("/assignments/") ? "/courses" : path;
  return (
    <nav className="flex flex-wrap gap-1 text-sm">
      {items.map((n) => {
        const active = section === n.href || (n.href !== "/admin" && section.startsWith(n.href + "/"));
        return (
          <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined} className={`rounded-md px-2.5 py-1.5 font-medium ${active ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100"}`}>
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
