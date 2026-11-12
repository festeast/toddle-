import { uuidOr404 } from "@/lib/validate";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { db } from "@/lib/db";
import { canManageCourse, canEditGrades } from "@/lib/access";
import { PageTitle, Card, Notice } from "@/components/ui";
import { AssignmentForm } from "@/components/gradebook/AssignmentForm";
import { todayIso, addDays, dateToIso } from "@/lib/dates";

export default async function NewAssignmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ period?: string }> }) {
  const id = uuidOr404((await params).id);
  const sp = await searchParams;
  const user = await requireUser();
  const { t, tj, locale } = await getT();
  const course = await db.course.findUnique({ where: { id }, include: { subject: { include: { criteria: { orderBy: { code: "asc" } } } }, programme: true } });
  if (!course) notFound();
  if (!(await canManageCourse(user, id))) return <Notice tone="red">{t("accessDenied")}</Notice>;
  const all = await db.gradingPeriod.findMany({ where: { academicYearId: course.academicYearId, programmeId: course.programmeId, kind: "REPORTING" }, orderBy: { sortOrder: "asc" } });
  // учитель создаёт задания только в открытых периодах; координатор — в любых
  const periods = [];
  for (const p of all) if (await canEditGrades(user, id, p.id)) periods.push(p);
  const back = `/courses/${id}${sp.period ? `?period=${encodeURIComponent(sp.period)}` : ""}`;
  if (periods.length === 0) {
    return (
      <>
        <PageTitle back={{ href: back, label: course.name }} title={t("newAssignment")} subtitle={`${course.name} · ${tj(course.subject.name)}`} />
        <Notice tone="amber">🔒 {t("periodLockedMsg")}</Notice>
      </>
    );
  }
  const today = todayIso();
  const period = periods.find((p) => p.abbreviation === sp.period) ?? periods.find((p) => dateToIso(p.startDate) <= today && dateToIso(p.endDate) >= today) ?? periods[0];
  // срок по умолчанию — через неделю, но в пределах выбранного периода
  const weekLater = addDays(today, 7);
  const due = weekLater < dateToIso(period.startDate) ? dateToIso(period.startDate) : weekLater > dateToIso(period.endDate) ? dateToIso(period.endDate) : weekLater;
  const isDP = course.programme.code === "DP";

  return (
    <>
      <PageTitle back={{ href: back, label: course.name }} title={t("newAssignment")} subtitle={`${course.name} · ${tj(course.subject.name)}`} />
      <Card className="max-w-2xl">
        <AssignmentForm
          locale={locale} courseId={id} cancelHref={back} scoreRequired={course.subject.criteria.length === 0}
          initial={{ title: "", type: "SUMMATIVE", due, periodId: period.id, maxScore: isDP ? "50" : "", criteria: [], instructions: "" }}
          periods={periods.map((p) => ({ id: p.id, name: p.name }))}
          criteria={course.subject.criteria.map((c) => ({ id: c.id, code: c.code, name: tj(c.name), maxLevel: c.maxLevel }))}
        />
      </Card>
    </>
  );
}
