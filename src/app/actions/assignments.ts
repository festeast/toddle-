"use server";
import { redirect, RedirectType } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canEditGrades, canManageCourse } from "@/lib/access";
import { recalcCourse } from "@/lib/grading/service";
import { isIso } from "@/lib/dates";
import { clip, isUuid } from "@/lib/validate";
import type { DictKey } from "@/lib/i18n-dict";

/** Состояние формы задания: код ошибки (ключ словаря) и введённые значения, чтобы форма не очищалась. */
export type AssignmentFormState = {
  error?: DictKey;
  /** число для подстановки в текст ошибки (например, наибольший уже выставленный балл) */
  errorValue?: number;
  values?: { title: string; type: string; due: string; periodId: string; maxScore: string; criteria: string[]; instructions: string };
};

/**
 * Создать задание или изменить существующее (если передан assignmentId).
 * Ошибки ввода возвращаются в форму, а не выбрасываются: учитель видит, что исправить.
 */
export async function saveAssignment(_prev: AssignmentFormState, formData: FormData): Promise<AssignmentFormState> {
  const user = await requireUser();
  const assignmentId = String(formData.get("assignmentId") ?? "");
  const values = {
    title: clip(formData.get("title"), 200),
    type: String(formData.get("type")) === "FORMATIVE" ? "FORMATIVE" : "SUMMATIVE",
    due: String(formData.get("due") ?? ""),
    periodId: String(formData.get("periodId") ?? ""),
    maxScore: String(formData.get("maxScore") ?? "").trim().replace(",", "."),
    criteria: formData.getAll("criteria").map(String),
    instructions: clip(formData.get("instructions"), 5000),
  };
  const fail = (error: DictKey, errorValue?: number): AssignmentFormState => ({ error, errorValue, values });

  const existing = assignmentId
    ? isUuid(assignmentId) ? await db.assignment.findUnique({ where: { id: assignmentId }, include: { criteria: true } }) : null
    : null;
  if (assignmentId && (!existing || existing.deletedAt)) return fail("errNotFound");
  const courseId = existing?.courseId ?? String(formData.get("courseId"));
  if (!isUuid(courseId) || !(await canManageCourse(user, courseId))) return fail("accessDenied");
  const course = await db.course.findUniqueOrThrow({ where: { id: courseId }, include: { groups: true, programme: true, subject: { include: { criteria: true } } } });
  // правка задания из заблокированного периода — только координатору
  if (existing && !(await canEditGrades(user, courseId, existing.periodId))) return fail("periodLockedMsg");

  if (!values.title) return fail("errTitleRequired");
  if (!isIso(values.due) || Number.isNaN(new Date(`${values.due}T00:00:00.000Z`).getTime())) return fail("errDateRequired");
  const period = isUuid(values.periodId)
    ? await db.gradingPeriod.findFirst({ where: { id: values.periodId, programmeId: course.programmeId, academicYearId: course.academicYearId, kind: "REPORTING" } })
    : null;
  if (!period) return fail("errPeriodInvalid");
  if (!(await canEditGrades(user, courseId, period.id))) return fail("periodLockedMsg");

  const critIds = [...new Set(values.criteria)].filter((id) => course.subject.criteria.some((c) => c.id === id));
  const maxScore = values.maxScore ? Number(values.maxScore) : null;
  if (maxScore != null && (!Number.isFinite(maxScore) || maxScore <= 0 || maxScore > 100000)) return fail("errMaxScore");
  if (critIds.length === 0 && maxScore == null) return fail("errNothingToGrade");

  const type = values.type as "FORMATIVE" | "SUMMATIVE";
  const category = await db.gradingCategory.findFirst({ where: { schoolId: course.schoolId, code: type } });
  const data = {
    title: values.title, type, periodId: period.id, categoryId: category?.id ?? null,
    dueAt: new Date(`${values.due}T13:00:00.000Z`), maxScore, isSummativeDate: type === "SUMMATIVE",
    hideTotalFromStudents: course.programme.code === "MYP" && type === "SUMMATIVE",
    instructions: { ru: values.instructions },
  };

  if (!existing) {
    const a = await db.assignment.create({
      data: {
        ...data, courseId, status: "PUBLISHED", publishAt: new Date(), createdById: user.id,
        criteria: { create: critIds.map((criterionId) => ({ criterionId, maxLevel: course.subject.criteria.find((c) => c.id === criterionId)?.maxLevel ?? 8 })) },
        targets: { create: course.groups.map((g) => ({ groupId: g.groupId })) },
      },
    });
    redirect(`/assignments/${a.id}?created=1`);
  }

  // ---- изменение: нельзя молча потерять уже выставленные оценки ----
  const top = await db.evaluation.aggregate({ where: { assignmentId: existing.id, score: { not: null } }, _max: { score: true } });
  const topScore = top._max.score == null ? null : Number(top._max.score);
  if (topScore != null && (maxScore == null || maxScore < topScore)) return fail("errMaxBelowScores", topScore);
  const removed = existing.criteria.filter((c) => !critIds.includes(c.criterionId)).map((c) => c.criterionId);
  if (removed.length) {
    const graded = await db.criterionEvaluation.count({ where: { criterionId: { in: removed }, level: { not: null }, evaluation: { assignmentId: existing.id } } });
    if (graded > 0) return fail("errCriterionHasGrades", graded);
  }
  const added = critIds.filter((id) => !existing.criteria.some((c) => c.criterionId === id));
  await db.$transaction([
    db.criterionEvaluation.deleteMany({ where: { criterionId: { in: removed }, evaluation: { assignmentId: existing.id } } }),
    db.assignmentCriterion.deleteMany({ where: { assignmentId: existing.id, criterionId: { in: removed } } }),
    db.assignmentCriterion.createMany({ data: added.map((criterionId) => ({ assignmentId: existing.id, criterionId, maxLevel: course.subject.criteria.find((c) => c.id === criterionId)?.maxLevel ?? 8 })) }),
    db.assignment.update({ where: { id: existing.id }, data }),
    db.auditLog.create({
      data: {
        schoolId: course.schoolId, actorId: user.id, action: "ASSIGNMENT_UPDATE", entityType: "Assignment", entityId: existing.id,
        // плоские значения: страница аудита показывает метаданные строкой «ключ: значение»
        meta: { course: course.name, title: values.title, type, period: period.abbreviation, maxScore, was: `${existing.title} · ${existing.type} · ${existing.maxScore == null ? "—" : Number(existing.maxScore)}` },
      },
    }),
  ]);
  // тип, период и максимум влияют на итоги всех учеников курса
  await recalcCourse(db, courseId);
  redirect(`/assignments/${existing.id}?saved=1`);
}

/** Удалить задание (мягко: оно скрывается из журнала и расчёта, но может быть восстановлено). */
export async function deleteAssignment(formData: FormData) {
  const user = await requireUser();
  const assignmentId = String(formData.get("assignmentId"));
  if (!isUuid(assignmentId)) throw new Error("bad id");
  const a = await db.assignment.findUnique({ where: { id: assignmentId }, include: { period: true, course: { select: { schoolId: true, name: true } }, _count: { select: { evaluations: true } } } });
  if (!a || a.deletedAt) throw new Error("not found");
  if (!(await canEditGrades(user, a.courseId, a.periodId))) throw new Error("forbidden");
  await db.assignment.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
  await db.auditLog.create({
    data: { schoolId: a.course.schoolId, actorId: user.id, action: "ASSIGNMENT_DELETE", entityType: "Assignment", entityId: a.id, meta: { title: a.title, course: a.course.name, period: a.period?.abbreviation ?? null, evaluations: a._count.evaluations } },
  });
  await recalcCourse(db, a.courseId);
  redirect(`/courses/${a.courseId}?period=${a.period?.abbreviation ?? ""}&deleted=${a.id}`);
}

/** Восстановить удалённое задание вместе с его оценками. */
export async function restoreAssignment(formData: FormData) {
  const user = await requireUser();
  const assignmentId = String(formData.get("assignmentId"));
  if (!isUuid(assignmentId)) throw new Error("bad id");
  const a = await db.assignment.findUnique({ where: { id: assignmentId }, include: { period: true, course: { select: { schoolId: true, name: true } } } });
  if (!a) throw new Error("not found");
  if (!(await canEditGrades(user, a.courseId, a.periodId))) throw new Error("forbidden");
  if (a.deletedAt) {
    await db.assignment.update({ where: { id: a.id }, data: { deletedAt: null } });
    await db.auditLog.create({
      data: { schoolId: a.course.schoolId, actorId: user.id, action: "ASSIGNMENT_RESTORE", entityType: "Assignment", entityId: a.id, meta: { title: a.title, course: a.course.name, period: a.period?.abbreviation ?? null } },
    });
    await recalcCourse(db, a.courseId);
  }
  redirect(`/courses/${a.courseId}?period=${a.period?.abbreviation ?? ""}`, RedirectType.replace);
}
