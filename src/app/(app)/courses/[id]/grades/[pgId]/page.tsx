import { uuidOr404 } from "@/lib/validate";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { db } from "@/lib/db";
import { canEditGrades, canManageCourse } from "@/lib/access";
import { PageTitle, Card, Grade7, Grade5, Level, Notice } from "@/components/ui";
import { overrideGrade } from "@/app/actions/grading";
import { fmtDateTime } from "@/lib/dates";

export default async function OverridePage({ params }: { params: Promise<{ id: string; pgId: string }> }) {
  const p = await params;
  const id = uuidOr404(p.id);
  const pgId = uuidOr404(p.pgId);
  const user = await requireUser();
  const { t, tj, locale } = await getT();
  const pg = await db.periodGrade.findUnique({ where: { id: pgId }, include: { period: true, course: true, student: { include: { user: true } }, criterionGrades: { include: { criterion: true } } } });
  if (!pg || pg.courseId !== id) notFound();
  if (!(await canManageCourse(user, id))) return <Notice tone="red">{t("accessDenied")}</Notice>;
  const canEdit = await canEditGrades(user, id, pg.periodId);
  const by = pg.overriddenById ? await db.user.findUnique({ where: { id: pg.overriddenById } }) : null;
  const history = await db.auditLog.findMany({ where: { entityType: "PeriodGrade", entityId: pgId }, orderBy: { createdAt: "desc" } });
  const actors = new Map((await db.user.findMany({ where: { id: { in: history.map((h) => h.actorId!).filter(Boolean) } } })).map((u) => [u.id, u]));

  return (
    <>
      <PageTitle back={{ href: `/courses/${id}?period=${pg.period.abbreviation}`, label: pg.course.name }} title={`${pg.student.user.lastName} ${pg.student.user.firstName}`} subtitle={`${pg.course.name} · ${pg.period.name}`} />
      {pg.period.locked && <Notice tone="amber">🔒 {t("periodLockedMsg")}</Notice>}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t("calculated")}>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            {pg.criterionGrades.sort((a, b) => a.criterion.code.localeCompare(b.criterion.code)).map((cg) => (
              <div key={cg.criterionId} className="contents"><dt className="text-slate-500">{cg.criterion.code}. {tj(cg.criterion.name)}</dt><dd><Level value={cg.level} /></dd></div>
            ))}
            {pg.criteriaSum != null && <><dt className="text-slate-500">{t("sum")} ({t("criteriaCount")}: {pg.criteriaCount})</dt><dd className="tabular-nums">{pg.criteriaSum}</dd></>}
            {pg.overallPct != null && <><dt className="text-slate-500">{t("overallPct")}</dt><dd className="tabular-nums">{Number(pg.overallPct).toFixed(2)}</dd></>}
            <dt className="text-slate-500">{t("grade7")}</dt><dd><Grade7 value={pg.grade7} /></dd>
            <dt className="text-slate-500">{t("grade5")}</dt><dd><Grade5 value={pg.grade5} /></dd>
          </dl>
          {pg.gradeOverride7 != null && (
            <div className="mt-4 rounded-lg bg-violet-50 p-3 text-sm text-violet-900">
              {t("overridden")}: <b>{pg.gradeOverride7}</b> / {pg.gradeOverride5} — {by ? `${by.lastName} ${by.firstName}` : ""}, {fmtDateTime(pg.overriddenAt, locale)}
            </div>
          )}
        </Card>
        <Card title={t("override")}>
          {canEdit ? (
            <form action={overrideGrade} className="space-y-3">
              <input type="hidden" name="periodGradeId" value={pg.id} />
              <div>
                <label className="label">{t("newGrade")} (1–7)</label>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5, 6, 7].map((g) => (
                    <label key={g}><input type="radio" name="grade7" value={g} defaultChecked={(pg.gradeOverride7 ?? pg.grade7) === g} className="peer sr-only" />
                      <span className="grid h-9 w-9 cursor-pointer place-items-center rounded-lg border border-slate-300 font-semibold peer-checked:border-violet-600 peer-checked:bg-violet-600 peer-checked:text-white">{g}</span></label>
                  ))}
                </div>
              </div>
              <div><label className="label" htmlFor="ov-reason">{t("reason")}</label><input id="ov-reason" name="reason" required maxLength={500} className="input w-full" placeholder="Решение педсовета, пересдача…" /></div>
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-primary">{t("save")}</button>
                {pg.gradeOverride7 != null && <button name="clear" value="1" formNoValidate className="btn">{t("clearOverride")}</button>}
              </div>
            </form>
          ) : <div className="text-sm text-slate-500">{t("periodLockedMsg")}</div>}
        </Card>
      </div>
      {history.length > 0 && (
        <Card title={t("auditLog")} className="mt-6">
          <table className="tbl">
            <thead><tr><th>{t("when")}</th><th>{t("who")}</th><th>{t("action")}</th><th>{t("reason")}</th></tr></thead>
            <tbody>
              {history.map((h) => {
                const m = (h.meta ?? {}) as Record<string, unknown>;
                const a = h.actorId ? actors.get(h.actorId) : null;
                return <tr key={h.id}><td>{fmtDateTime(h.createdAt, locale)}</td><td>{a ? `${a.lastName} ${a.firstName}` : "—"}</td><td>{h.action}: {String(m.from ?? "—")} → {String(m.to ?? "—")}</td><td>{String(m.reason ?? "")}</td></tr>;
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
