import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { db } from "@/lib/db";
import { isSchoolAdmin } from "@/lib/access";
import { PageTitle, Card, Badge } from "@/components/ui";
import type { Prisma } from "@prisma/client";

export default async function CoursesPage() {
  const user = await requireUser();
  const { t, tj } = await getT();
  const scopeProgrammes = user.roles.filter((r) => r.role === "COORDINATOR" || r.role === "DEPUTY_HEAD").map((r) => r.programmeId);
  const allProgrammes = isSchoolAdmin(user) || scopeProgrammes.includes(null);
  // Админ и сотрудники без ограничения программой видят все курсы; остальные — свои и своей программы
  const or: Prisma.CourseWhereInput[] = [];
  if (user.staffProfile) or.push({ staff: { some: { staffId: user.staffProfile.id } } });
  if (scopeProgrammes.length) or.push({ programmeId: { in: scopeProgrammes.filter(Boolean) as string[] } });
  const courses = allProgrammes || or.length
    ? await db.course.findMany({
        where: { deletedAt: null, archived: false, ...(allProgrammes ? {} : { OR: or }) },
        include: { subject: true, programme: true, groups: { include: { group: true } }, staff: { include: { staff: { include: { user: true } } } }, _count: { select: { enrollments: { where: { status: "ACTIVE" } }, assignments: { where: { deletedAt: null } } } } },
        orderBy: [{ programme: { code: "desc" } }, { name: "asc" }],
      })
    : [];
  const byClass = new Map<string, typeof courses>();
  for (const c of courses) {
    const k = c.groups[0]?.group.name ?? "—";
    byClass.set(k, [...(byClass.get(k) ?? []), c]);
  }
  return (
    <>
      <PageTitle title={allProgrammes || scopeProgrammes.length ? t("courses") : t("navCourses")} subtitle={`${courses.length}`} />
      <div className="space-y-6">
        {[...byClass.entries()].map(([cls, list]) => (
          <div key={cls}>
            <h2 className="mb-2 text-sm font-semibold text-slate-600">{t("homeroom")} {cls} <Badge>{list[0].programme.code}</Badge></h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((c) => (
                <Link key={c.id} href={`/courses/${c.id}`} className="card block overflow-hidden hover:border-brand-500">
                  <div className="h-1.5" style={{ background: c.color ?? "#94a3b8" }} />
                  <div className="p-4">
                    <div className="font-medium">{c.name}</div>
                    <div className="text-sm text-slate-500">{tj(c.subject.name)}{c.level !== "NONE" ? ` ${c.level}` : ""}</div>
                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
                      <span>👤 {c.staff.map((s) => s.staff.user.lastName).join(", ")}</span>
                      <span>{c._count.enrollments} {t("students").toLowerCase()}</span>
                      <span>{c._count.assignments} {t("assignmentsCount").toLowerCase()}</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        ))}
        {courses.length === 0 && <Card><div className="text-slate-500">{t("noData")}</div></Card>}
      </div>
    </>
  );
}
