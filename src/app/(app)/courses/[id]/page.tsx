import { isUuid, uuidOr404 } from "@/lib/validate";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { db } from "@/lib/db";
import { canManageCourse, canEditGrades } from "@/lib/access";
import { PageTitle, Card, Grade7, Grade5, Badge, Notice, Tabs } from "@/components/ui";
import { recalcAction, publishPeriod } from "@/app/actions/grading";
import { restoreAssignment } from "@/app/actions/assignments";
import { loadPeriodGradebook } from "@/lib/grading/gradebook";
import type { GbColumn } from "@/lib/grading/types";
import { GradebookGrid } from "@/components/gradebook/GradebookGrid";
import { fmtDate, dateToIso } from "@/lib/dates";

export default async function GradebookPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ period?: string; recalc?: string; deleted?: string }> }) {
  const id = uuidOr404((await params).id);
  const sp = await searchParams;
  const user = await requireUser();
  const { t, tj, locale } = await getT();
  const course = await db.course.findUnique({
    where: { id },
    include: {
      subject: { include: { criteria: { orderBy: { code: "asc" } } } }, programme: true,
      staff: { include: { staff: { include: { user: true } } } },
      enrollments: { where: { status: "ACTIVE" }, include: { student: { include: { user: true } } } },
    },
  });
  if (!course) notFound();
  if (!(await canManageCourse(user, id))) return <Notice tone="red">{t("accessDenied")}</Notice>;

  const periods = await db.gradingPeriod.findMany({ where: { academicYearId: course.academicYearId, programmeId: course.programmeId }, include: { contributesTo: { include: { child: true } } }, orderBy: { sortOrder: "asc" } });
  if (periods.length === 0) return <Notice tone="amber">{t("noData")}</Notice>;
  const today = new Date();
  const defaultPeriod = periods.find((p) => p.kind === "REPORTING" && p.startDate <= today && p.endDate >= today) ?? periods[0];
  const period = periods.find((p) => p.abbreviation === sp.period) ?? defaultPeriod;
  const canEdit = await canEditGrades(user, id, period.id);
  const students = course.enrollments.map((e) => e.student).sort((a, b) => a.user.lastName.localeCompare(b.user.lastName, "ru") || a.user.firstName.localeCompare(b.user.firstName, "ru"));
  const studentIds = students.map((s) => s.id);
  const criteria = course.subject.criteria;
  const isReporting = period.kind === "REPORTING";

  const gb = isReporting ? await loadPeriodGradebook(course, period.id, studentIds) : null;
  // накопительный период: итоги самого периода и входящих в него
  const childIds = period.contributesTo.map((c) => c.childId);
  const pgs = isReporting ? [] : await db.periodGrade.findMany({ where: { courseId: id, periodId: { in: [period.id, ...childIds] } } });
  const pgOf = (sid: string, pid: string) => pgs.find((p) => p.studentId === sid && p.periodId === pid);

  const publishedFlags = gb ? studentIds.map((sid) => gb.totals[sid]).filter((x) => x.pgId).map((x) => x.published) : pgs.filter((p) => p.periodId === period.id).map((p) => p.published);
  const publishedCount = publishedFlags.filter(Boolean).length;
  const allPublished = publishedFlags.length > 0 && publishedCount === publishedFlags.length;

  // только что удалённое задание — предлагаем восстановить
  const deleted = isUuid(sp.deleted) ? await db.assignment.findFirst({ where: { id: sp.deleted, courseId: id, deletedAt: { not: null } }, select: { id: true, title: true } }) : null;

  const columns: GbColumn[] = (gb?.assignments ?? []).map((a) => ({
    id: a.id, title: a.title, type: a.type === "FORMATIVE" ? "FORMATIVE" : "SUMMATIVE",
    due: fmtDate(a.dueAt, locale), dueIso: a.dueAt ? dateToIso(a.dueAt) : null,
    maxScore: a.maxScore == null ? null : Number(a.maxScore), categoryCode: a.category?.code ?? null,
    criteria: a.criteria.map((c) => ({ id: c.criterionId, code: c.criterion.code, name: tj(c.criterion.name), maxLevel: c.maxLevel })),
    countsForCriteria: a.type === "SUMMATIVE" || !!gb?.policy.allowFormativeInFinal,
  }));
  const categories = (gb?.categories ?? []).map((c) => ({ code: c.code, weight: c.weight, name: tj(c.name) }));
  const showPercent = !!gb && gb.policy.usePercentMethod && categories.length > 0 && (criteria.length === 0 || columns.some((c) => c.maxScore != null));
  const sortCookie = (await cookies()).get("gb_sort")?.value;

  const dist = [1, 2, 3, 4, 5, 6, 7].map((g) => students.filter((s) => { const pg = pgOf(s.id, period.id); return (pg?.gradeOverride7 ?? pg?.grade7) === g; }).length);
  const maxDist = Math.max(1, ...dist);

  return (
    <div className="gb-bleed"><div className="gb-shell">
      <div className="gb-fit">
      <PageTitle
        back={{ href: "/courses", label: t("courses") }}
        title={course.name}
        subtitle={`${tj(course.subject.name)}${course.level !== "NONE" ? " " + course.level : ""} · ${course.programme.code} · ${course.staff.map((s) => `${s.staff.user.lastName} ${s.staff.user.firstName}`).join(", ")}`}
        actions={canEdit && isReporting ? <Link className="btn btn-primary" href={`/courses/${id}/new?period=${period.abbreviation}`}>+ {t("newAssignment")}</Link> : null}
      />
      <Tabs items={periods.map((p) => ({ href: `/courses/${id}?period=${p.abbreviation}`, title: p.name, label: <>{p.abbreviation}{p.locked ? " 🔒" : ""}</>, active: p.id === period.id }))} />
      {period.locked && <Notice tone="amber">🔒 {t("periodLockedMsg")}</Notice>}
      {sp.recalc && <Notice tone="green">✓ {t("recalcDone")}</Notice>}
      {deleted && (
        <Notice tone="amber">
          <form action={restoreAssignment} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <input type="hidden" name="assignmentId" value={deleted.id} />
            <span><b>{deleted.title}</b> — {t("assignmentDeleted")}</span>
            {canEdit && <button className="btn btn-sm">{t("restore")}</button>}
          </form>
        </Notice>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="text-sm text-slate-500">{period.name} · {fmtDate(period.startDate, locale)} – {fmtDate(period.endDate, locale)}</div>
        <Badge tone={allPublished ? "green" : "slate"}>{publishedCount ? `${t("published")}: ${publishedCount}/${publishedFlags.length}` : t("notPublished")}</Badge>
        <div className="ml-auto flex flex-wrap gap-2">
          <form action={recalcAction}><input type="hidden" name="courseId" value={id} /><input type="hidden" name="period" value={period.abbreviation} /><button className="btn btn-sm">↻ {t("recalc")}</button></form>
          {canEdit && (
            <form action={publishPeriod}>
              <input type="hidden" name="courseId" value={id} /><input type="hidden" name="periodId" value={period.id} />
              <input type="hidden" name="publish" value={allPublished ? "0" : "1"} />
              <button disabled={publishedFlags.length === 0} className={`btn btn-sm ${allPublished ? "" : "btn-primary"}`}>
                {allPublished ? t("unpublishPeriod") : t("publishPeriod")}
              </button>
            </form>
          )}
        </div>
      </div>
      </div>

      {gb ? (
        <GradebookGrid
          version={Date.now()} locale={locale} courseId={id} periodAbbr={period.abbreviation} canEdit={canEdit}
          students={students.map((s) => ({ id: s.id, name: `${s.user.lastName} ${s.user.firstName}` }))}
          columns={columns} cells={gb.cells} totals={gb.totals}
          subjectCriteria={criteria.map((c) => ({ id: c.id, code: c.code, name: tj(c.name) }))}
          categories={categories} showPercent={showPercent} initialSort={sortCookie === "asc" ? "asc" : "desc"}
        />
      ) : (
        <div className="gb-fit">
          <Notice>{t("cumulativeHint")}</Notice>
          <Card className="mb-6">
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 bg-slate-50">{t("student")}</th>
                    {period.contributesTo.map((c) => (
                      <th key={c.id} className="text-center">
                        <Link href={`/courses/${id}?period=${c.child.abbreviation}`} className="hover:text-brand-700 hover:underline" title={c.child.name}>{c.child.abbreviation}</Link>
                        <div className="font-normal text-slate-400">{t("weight")} ×{Number(c.weight)}</div>
                      </th>
                    ))}
                    <th className="bg-blue-50 text-center">{t("grade7")}</th>
                    <th className="bg-blue-50 text-center">{t("grade5")}</th>
                  </tr>
                </thead>
                <tbody>
                  {students.map((s) => {
                    const pg = pgOf(s.id, period.id);
                    return (
                      <tr key={s.id}>
                        <td className="sticky left-0 z-10 whitespace-nowrap bg-white font-medium">
                          <Link href={`/students/${s.id}`} className="hover:underline">{s.user.lastName} {s.user.firstName}</Link>
                        </td>
                        {period.contributesTo.map((c) => {
                          const cp = pgOf(s.id, c.childId);
                          return <td key={c.id} className="text-center"><Grade7 value={cp?.gradeOverride7 ?? cp?.grade7} overridden={cp?.gradeOverride7 != null} muted /></td>;
                        })}
                        <td className="bg-blue-50/40 text-center">
                          {pg && (pg.gradeOverride7 ?? pg.grade7) != null ? (
                            <Link href={`/courses/${id}/grades/${pg.id}`} title={t("overrideHint")} className="inline-flex items-center gap-1">
                              <Grade7 value={pg.gradeOverride7 ?? pg.grade7} overridden={pg.gradeOverride7 != null} />
                              {pg.published && <span className="text-[10px] text-green-600" title={t("published")}>●</span>}
                            </Link>
                          ) : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="bg-blue-50/40 text-center"><Grade5 value={pg?.gradeOverride5 ?? pg?.grade5} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-500">
              <span><span className="text-green-600">●</span> {t("published")}</span>
              <span><span className="rounded ring-2 ring-violet-400">&nbsp;&nbsp;&nbsp;</span> {t("overridden")}</span>
            </div>
          </Card>
          <Card title={`${t("distribution")} · ${period.abbreviation}`}>
            <div className="flex h-28 items-end gap-3">
              {dist.map((n, i) => (
                <div key={i} className="flex flex-1 flex-col items-center gap-1">
                  <div className="text-xs tabular-nums text-slate-500">{n}</div>
                  <div className="w-full rounded-t bg-brand-500" style={{ height: `${(n / maxDist) * 56}px`, minHeight: n ? 2 : 0 }} />
                  <div className="text-xs font-medium">{i + 1}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div></div>
  );
}
