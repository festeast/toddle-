import { uuidOr404 } from "@/lib/validate";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { db } from "@/lib/db";
import { canManageCourse, canEditGrades } from "@/lib/access";
import { PageTitle, Badge, Notice } from "@/components/ui";
import { AssignmentGrid } from "@/components/gradebook/AssignmentGrid";
import { toCell } from "@/lib/grading/gradebook";
import type { Cell, GbColumn } from "@/lib/grading/types";
import { fmtDate, dateToIso } from "@/lib/dates";
import { summativeLoad } from "@/lib/workload";

export default async function AssignmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; created?: string }> }) {
  const id = uuidOr404((await params).id);
  const sp = await searchParams;
  const user = await requireUser();
  const { t, tj, locale } = await getT();
  const a = await db.assignment.findUnique({
    where: { id },
    include: {
      period: true, category: true,
      criteria: { include: { criterion: true }, orderBy: { criterion: { code: "asc" } } },
      course: { include: { enrollments: { where: { status: "ACTIVE" }, include: { student: { include: { user: true } } } } } },
      evaluations: { include: { criteria: true } }, submissions: true,
    },
  });
  if (!a || a.deletedAt) notFound();
  if (!(await canManageCourse(user, a.courseId))) return <Notice tone="red">{t("accessDenied")}</Notice>;
  const canEdit = await canEditGrades(user, a.courseId, a.periodId);
  const students = a.course.enrollments.map((e) => e.student).sort((x, y) => x.user.lastName.localeCompare(y.user.lastName, "ru") || x.user.firstName.localeCompare(y.user.firstName, "ru"));
  const load = a.type === "SUMMATIVE" && a.dueAt ? await summativeLoad(a.courseId, dateToIso(a.dueAt)) : 0;
  const policy = await db.gradingPolicy.findFirst({ where: { programmeId: a.course.programmeId }, select: { maxSummativePerDay: true, allowFormativeInFinal: true } });

  const critIds = a.criteria.map((c) => c.criterionId);
  const evs = new Map(a.evaluations.map((e) => [e.studentId, e]));
  const subs = new Map(a.submissions.map((s) => [s.studentId, s]));
  const cells: Record<string, Cell> = {};
  for (const s of students) {
    const ev = evs.get(s.id);
    const sub = subs.get(s.id);
    if (ev || sub) cells[s.id] = toCell(critIds, ev, sub);
  }
  const column: GbColumn = {
    id: a.id, title: a.title, type: a.type === "FORMATIVE" ? "FORMATIVE" : "SUMMATIVE",
    due: fmtDate(a.dueAt, locale), dueIso: a.dueAt ? dateToIso(a.dueAt) : null,
    maxScore: a.maxScore == null ? null : Number(a.maxScore), categoryCode: a.category?.code ?? null,
    criteria: a.criteria.map((c) => ({ id: c.criterionId, code: c.criterion.code, name: tj(c.criterion.name), maxLevel: c.maxLevel })),
    countsForCriteria: a.type === "SUMMATIVE" || !!policy?.allowFormativeInFinal,
  };
  const instructions = tj(a.instructions);
  const gradebookHref = `/courses/${a.courseId}?period=${a.period?.abbreviation ?? ""}`;

  return (
    <>
      <PageTitle
        back={{ href: gradebookHref, label: `${a.course.name} · ${t("gradebook").toLowerCase()}` }}
        title={a.title}
        subtitle={<span className="flex flex-wrap items-center gap-2">
          <Badge tone={a.type === "SUMMATIVE" ? "violet" : "blue"}>{t(`type_${a.type}` as never)}</Badge>
          <span>{t("dueDate")}: {fmtDate(a.dueAt, locale, { day: "numeric", month: "long" })}</span>
          {a.period && <span>· {a.period.name}{a.period.locked ? " 🔒" : ""}</span>}
          {a.maxScore != null && <span>· {t("maxScore")}: {Number(a.maxScore)}</span>}
          {a.hideTotalFromStudents && <Badge>{t("hiddenTotal")}</Badge>}
        </span>}
        actions={canEdit ? <Link className="btn" href={`/assignments/${a.id}/edit`}>{t("edit")}</Link> : null}
      />
      {sp.created && <Notice tone="green">✓ {t("assignmentCreated")}</Notice>}
      {sp.saved && <Notice tone="green">✓ {t("saved")}</Notice>}
      {load > (policy?.maxSummativePerDay ?? 3) && <Notice tone="amber">⚠ {t("summativeLimitWarn")} ({load})</Notice>}
      {!canEdit && <Notice tone="amber">🔒 {t("periodLockedMsg")}</Notice>}
      {column.criteria.length === 0 && column.maxScore == null && <Notice tone="amber">⚠ {t("noScale")}</Notice>}

      {(instructions || a.criteria.length > 0) && (
        <div className="mb-4 space-y-3">
          {instructions && <div className="card whitespace-pre-line px-4 py-3 text-sm text-slate-700"><div className="label">{t("description")}</div>{instructions}</div>}
          {a.criteria.length > 0 && (
            <div className="flex flex-wrap gap-2 text-sm">
              {a.criteria.map((c) => <span key={c.criterionId} className="rounded-lg bg-white px-3 py-1.5 shadow-sm ring-1 ring-slate-200"><b>{c.criterion.code}</b> {tj(c.criterion.name)} <span className="text-slate-400">0–{c.maxLevel}</span></span>)}
            </div>
          )}
        </div>
      )}

      <AssignmentGrid
        version={Date.now()} locale={locale} canEdit={canEdit} assignment={column} cells={cells}
        students={students.map((s) => ({ id: s.id, name: `${s.user.lastName} ${s.user.firstName}` }))}
      />
    </>
  );
}
