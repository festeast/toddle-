import Link from "next/link";
import { headers } from "next/headers";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { db } from "@/lib/db";
import { canAdmin, hasRole } from "@/lib/access";
import { logout } from "@/app/actions/session";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import { NavLinks } from "@/components/NavLinks";
import type { DictKey } from "@/lib/i18n-dict";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const { t, locale } = await getT();
  const path = (await headers()).get("x-pathname") ?? "/";
  const unread = await db.notification.count({ where: { recipientId: user.id, readAt: null } });

  const nav: { href: string; key: DictKey }[] = [];
  if (canAdmin(user)) nav.push({ href: "/admin", key: "overview" });
  if (hasRole(user, "TEACHER")) nav.push({ href: "/today", key: "navToday" });
  if (hasRole(user, "TEACHER") || canAdmin(user)) nav.push({ href: "/courses", key: canAdmin(user) ? "courses" : "navCourses" });
  if (canAdmin(user)) nav.push({ href: "/admin/policy", key: "navPolicy" }, { href: "/admin/people", key: "navPeople" }, { href: "/admin/audit", key: "auditLog" });
  if (user.studentProfile) nav.push({ href: "/me", key: "myGrades" });
  if (user.guardianProfile) nav.push({ href: "/family", key: "myGrades" });

  const roleText = [...new Set(user.roles.map((r) => t(`role_${r.role}` as DictKey) + (r.programme ? ` ${r.programme.code}` : "")))].join(" · ");

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-brand-600 text-xs font-bold text-white">IB</span>
            {t("appName")}
          </Link>
          <NavLinks items={nav.map((n) => ({ href: n.href, label: t(n.key) }))} />
          <div className="ml-auto flex items-center gap-3">
            <Link href="/notifications" className="relative rounded-md px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100" title={t("navNotifications")}>
              🔔{unread > 0 && <span className="absolute -right-1 -top-1 min-w-[1.1rem] rounded-full bg-red-600 px-1 text-center text-[10px] font-bold leading-[1.1rem] text-white">{unread > 99 ? "99+" : unread}</span>}
            </Link>
            <LocaleSwitch current={locale} back={path} />
            <div className="hidden text-right leading-tight sm:block">
              <div className="text-sm font-medium">{user.lastName} {user.firstName}</div>
              <div className="text-xs text-slate-500">{roleText}</div>
            </div>
            <form action={logout}><button className="btn btn-sm">{t("logout")}</button></form>
          </div>
        </div>
      </header>
      {config.demoMode && <div className="bg-amber-50 py-1 text-center text-xs text-amber-800">{t("demoBanner")}</div>}
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
