import { uuidOr404 } from "@/lib/validate";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { db } from "@/lib/db";
import { canManageCourse, canEditGrades } from "@/lib/access";
import { PageTitle, Card, Notice } from "@/components/ui";
import { AssignmentForm, ConfirmSubmit } from "@/components/gradebook/AssignmentForm";
import { deleteAssignment } from "@/app/actions/assignments";
import { dateToIso, todayIso } from "@/lib/dates";

export default async function EditAssignmentPage({ params }: { params: Promise<{ id: string }> }) {
  const id = uuidOr404((await params).id);
  const user = await requireUser();
  const { t, tj, locale } = await getT();
  const a = await db.assignment.findUnique({
    where: { id },
    include: { criteria: true, period: true, course: { include: { subject: { include: { criteria: { orderBy: { code: "asc" } } } } } }, _count: { select: { evaluations: { where: { status: { in: ["EVALUATED", "SHARED"] } } } } } },
  });
  if (!a || a.deletedAt) notFound();
  if (!(await canManageCourse(user, a.courseId))) return <Notice tone="red">{t("accessDenied")}</Notice>;
  const back = `/assignments/${a.id}`;
  if (!(await canEditGrades(user, a.courseId, a.periodId))) {
    return (
      <>
        <PageTitle back={{ href: back, label: a.title }} title={t("editAssignment")} subtitle={a.course.name} />
        <Notice tone="amber">🔒 {t("periodLockedMsg")}</Notice>
      </>
    );
  }
  const all = await db.gradingPeriod.findMany({ where: { academicYearId: a.course.academicYearId, programmeId: a.course.programmeId, kind: "REPORTING" }, orderBy: { sortOrder: "asc" } });
  const periods = [];
  for (const p of all) if (p.id === a.periodId || (await canEditGrades(user, a.courseId, p.id))) periods.push(p);
  const instructions = a.instructions && typeof a.instructions === "object" ? ((a.instructions as Record<string, string>).ru ?? tj(a.instructions)) : "";

  return (
    <>
      <PageTitle back={{ href: back, label: a.title }} title={t("editAssignment")} subtitle={`${a.course.name} · ${tj(a.course.subject.name)}`} />
      <Card className="max-w-2xl">
        <AssignmentForm
          locale={locale} courseId={a.courseId} assignmentId={a.id} cancelHref={back} scoreRequired={a.course.subject.criteria.length === 0}
          initial={{
            title: a.title, type: a.type === "FORMATIVE" ? "FORMATIVE" : "SUMMATIVE", due: a.dueAt ? dateToIso(a.dueAt) : todayIso(),
            periodId: a.periodId ?? periods[0]?.id ?? "", maxScore: a.maxScore == null ? "" : String(Number(a.maxScore)),
            criteria: a.criteria.map((c) => c.criterionId), instructions,
          }}
          periods={periods.map((p) => ({ id: p.id, name: p.name }))}
          criteria={a.course.subject.criteria.map((c) => ({ id: c.id, code: c.code, name: tj(c.name), maxLevel: c.maxLevel }))}
        />
      </Card>
      <Card className="mt-6 max-w-2xl" title={t("deleteAssignment")}>
        <form action={deleteAssignment} className="flex flex-wrap items-center justify-between gap-3">
          <input type="hidden" name="assignmentId" value={a.id} />
          <p className="max-w-md text-sm text-slate-600">{t("deleteAssignmentHint")}</p>
          <ConfirmSubmit className="btn btn-danger" message={`${t("deleteAssignmentConfirm")} ${a._count.evaluations}`}>{t("deleteAssignment")}</ConfirmSubmit>
        </form>
      </Card>
    </>
  );
}
