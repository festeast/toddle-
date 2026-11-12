"use server";
import { redirect, RedirectType } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser, fullName } from "@/lib/auth";
import { canEditGrades, canManageCourse, isCoordinatorOf, isSchoolAdmin } from "@/lib/access";
import { recalcCourse, fiveFor } from "@/lib/grading/service";
import { applyCellPatch, notifyFamilies, setAssignmentShared, SUB_STATUSES } from "@/lib/grading/gradebook";
import type { SaveError, SaveResult } from "@/lib/grading/types";
import { clip, isUuid } from "@/lib/validate";

const SaveCellSchema = z.object({
  assignmentId: z.string().uuid(),
  studentId: z.string().uuid(),
  patch: z.object({
    score: z.number().finite().nullable().optional(),
    levels: z.record(z.string().uuid(), z.number().int().nullable()).optional(),
    sub: z.enum(SUB_STATUSES as [string, ...string[]]).optional(),
    comment: z.string().max(5000).optional(),
  }).strict(),
});

/**
 * Сохранить одну ячейку журнала (оценка, уровни критериев, статус сдачи или комментарий).
 * Вызывается из браузера при каждом изменении; возвращает сохранённую ячейку и пересчитанный итог ученика.
 * Ошибки проверки возвращаются значением, а не исключением, чтобы учитель видел подсказку прямо в журнале.
 */
export async function saveCell(input: unknown): Promise<SaveResult> {
  const user = await requireUser();
  const parsed = SaveCellSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { assignmentId, studentId, patch } = parsed.data;
  return applyCellPatch(user, assignmentId, studentId, patch as Parameters<typeof applyCellPatch>[3]);
}

/** Опубликовать оценки задания ученикам и родителям или скрыть их обратно. */
export async function setAssignmentPublished(assignmentId: unknown, publish: unknown): Promise<{ ok: true; count: number } | { ok: false; error: SaveError }> {
  const user = await requireUser();
  if (!isUuid(assignmentId) || typeof publish !== "boolean") return { ok: false, error: "invalid" };
  const res = await setAssignmentShared(user, assignmentId, publish);
  return res ? { ok: true, count: res.count } : { ok: false, error: "forbidden" };
}

export async function recalcAction(formData: FormData) {
  const user = await requireUser();
  const courseId = String(formData.get("courseId"));
  if (!isUuid(courseId) || !(await canManageCourse(user, courseId))) throw new Error("forbidden");
  await recalcCourse(db, courseId);
  const period = String(formData.get("period") ?? "").replace(/[^A-Z0-9]/g, "").slice(0, 4);
  redirect(`/courses/${courseId}?period=${period}&recalc=1`, RedirectType.replace);
}

export async function publishPeriod(formData: FormData) {
  const user = await requireUser();
  const courseId = String(formData.get("courseId"));
  const periodId = String(formData.get("periodId"));
  if (!isUuid(courseId) || !isUuid(periodId)) throw new Error("bad id");
  const publish = String(formData.get("publish")) === "1";
  if (!(await canEditGrades(user, courseId, periodId))) throw new Error("forbidden");
  const course = await db.course.findUniqueOrThrow({ where: { id: courseId } });
  const period = await db.gradingPeriod.findUniqueOrThrow({ where: { id: periodId } });
  await db.periodGrade.updateMany({ where: { courseId, periodId }, data: { published: publish } });
  if (publish) {
    const pgs = await db.periodGrade.findMany({ where: { courseId, periodId }, select: { studentId: true } });
    await notifyFamilies(pgs.map((p) => p.studentId), "PERIOD_PUBLISHED", `Итоги ${period.name}: ${course.name}`, "Course", courseId);
  }
  await db.auditLog.create({ data: { schoolId: course.schoolId, actorId: user.id, action: publish ? "PERIOD_PUBLISH" : "PERIOD_UNPUBLISH", entityType: "Course", entityId: courseId, meta: { period: period.abbreviation, course: course.name } } });
  redirect(`/courses/${courseId}?period=${period.abbreviation}`, RedirectType.replace);
}

export async function overrideGrade(formData: FormData) {
  const user = await requireUser();
  const pgId = String(formData.get("periodGradeId"));
  if (!isUuid(pgId)) throw new Error("bad id");
  const clear = formData.get("clear") != null;
  const pg = await db.periodGrade.findUniqueOrThrow({ where: { id: pgId }, include: { course: true, period: true, student: { include: { user: true } } } });
  if (!(await canEditGrades(user, pg.courseId, pg.periodId))) throw new Error("forbidden");
  const reason = clip(formData.get("reason"), 500);
  let g7: number | null = null;
  if (!clear) {
    g7 = Number(formData.get("grade7"));
    if (!Number.isInteger(g7) || g7 < 1 || g7 > 7) throw new Error("Оценка 1–7");
    if (!reason) throw new Error("Укажите причину");
  }
  const g5 = g7 == null ? null : await fiveFor(db, pg.course.programmeId, g7);
  await db.periodGrade.update({
    where: { id: pgId },
    data: { gradeOverride7: g7, gradeOverride5: g5, overriddenById: clear ? null : user.id, overriddenAt: clear ? null : new Date() },
  });
  await db.auditLog.create({
    data: {
      schoolId: pg.course.schoolId, actorId: user.id, action: clear ? "GRADE_OVERRIDE_CLEAR" : "GRADE_OVERRIDE", entityType: "PeriodGrade", entityId: pgId,
      meta: { from: pg.gradeOverride7 ?? pg.grade7, to: g7 ?? pg.grade7, reason: reason || null, student: fullName(pg.student.user), course: pg.course.name, period: pg.period.abbreviation },
    },
  });
  await recalcCourse(db, pg.courseId, [pg.studentId]);
  redirect(`/courses/${pg.courseId}?period=${pg.period.abbreviation}`);
}

export async function toggleLock(formData: FormData) {
  const user = await requireUser();
  const periodId = String(formData.get("periodId"));
  if (!isUuid(periodId)) throw new Error("bad id");
  const p = await db.gradingPeriod.findUniqueOrThrow({ where: { id: periodId }, include: { programme: true } });
  if (!(isSchoolAdmin(user) || isCoordinatorOf(user, p.programmeId))) throw new Error("forbidden");
  await db.gradingPeriod.update({ where: { id: periodId }, data: { locked: !p.locked } });
  await db.auditLog.create({ data: { schoolId: p.programme.schoolId, actorId: user.id, action: p.locked ? "PERIOD_UNLOCK" : "PERIOD_LOCK", entityType: "GradingPeriod", entityId: periodId, meta: { period: p.abbreviation, programme: p.programme.code } } });
  redirect("/admin");
}
