/**
 * Журнал: загрузка данных периода и сохранение одной ячейки (оценка ученика за задание).
 * Серверный модуль. Права проверяются здесь, а не в интерфейсе.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { canEditGrades } from "@/lib/access";
import { recalcCourse, loadPolicy, calcPolicyOf } from "./service";
import { computeStudentTerm, weightsFor, type Missed, type TermContext } from "./term";
import { EMPTY_TOTALS, type Cell, type CellPatch, type EvStatus, type RowTotals, type SaveResult, type SubStatus } from "./types";

const DAY = 86400000;
/** Срок пересдачи при пропуске по уважительной причине (политика: в течение недели). */
const MAKEUP_DAYS = 7;
export const SUB_STATUSES: SubStatus[] = ["NOT_SUBMITTED", "SUBMITTED", "LATE", "RETURNED", "MISSED_VALID", "MISSED_INVALID"];
const isMissed = (s: string | null | undefined) => s === "MISSED_VALID" || s === "MISSED_INVALID";

type EvRow = { status: string; score: Prisma.Decimal | number | null; comment: unknown; criteria: { criterionId: string; level: number | null }[] };
type SubRow = { status: string; makeupUntil: Date | null };

/** Текст комментария из Json-поля ({ text }) — пустая строка, если комментария нет. */
export function commentText(c: unknown): string {
  if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") return (c as { text: string }).text;
  return "";
}

export function toCell(criterionIds: string[], ev?: EvRow | null, sub?: SubRow | null): Cell {
  const levels: Record<string, number | null> = {};
  for (const id of criterionIds) levels[id] = ev?.criteria.find((x) => x.criterionId === id)?.level ?? null;
  return {
    score: ev?.score == null ? null : Number(ev.score),
    levels,
    ev: (ev?.status ?? "NOT_EVALUATED") as EvStatus,
    sub: (sub?.status ?? "NOT_SUBMITTED") as SubStatus,
    comment: commentText(ev?.comment),
    makeupUntil: sub?.status === "MISSED_VALID" && sub.makeupUntil ? sub.makeupUntil.toISOString() : null,
  };
}

type PgRow = {
  id: string; overallPct: Prisma.Decimal | number | null; grade7: number | null; grade5: number | null;
  gradeOverride7: number | null; gradeOverride5: number | null; published: boolean;
  criteriaSum: number | null; criteriaCount: number | null;
  criterionGrades: { criterionId: string; level: number | null; overrideLevel: number | null }[];
};

export function toRowTotals(pg: PgRow | null | undefined, categoryPct?: Record<string, number>): RowTotals {
  if (!pg) return { ...EMPTY_TOTALS, categoryPct: categoryPct ?? {} };
  return {
    pgId: pg.id,
    overallPct: pg.overallPct == null ? null : Number(pg.overallPct),
    grade7: pg.gradeOverride7 ?? pg.grade7,
    calc7: pg.grade7,
    grade5: pg.gradeOverride5 ?? pg.grade5,
    overridden: pg.gradeOverride7 != null,
    published: pg.published,
    criteria: Object.fromEntries(pg.criterionGrades.map((c) => [c.criterionId, c.overrideLevel ?? c.level])),
    criteriaSum: pg.criteriaSum,
    criteriaCount: pg.criteriaCount,
    categoryPct: categoryPct ?? {},
  };
}

type CourseRef = { id: string; programmeId: string; academicYearId: string; subject: { criteria: { id: string; code: string }[] } };

/** Все данные журнала за reporting-период: задания, ячейки, итоги учеников и веса категорий. */
export async function loadPeriodGradebook(course: CourseRef, periodId: string, studentIds: string[]) {
  const [assignments, pgs, weightRows, pol] = await Promise.all([
    db.assignment.findMany({
      where: { courseId: course.id, periodId, deletedAt: null, type: { in: ["SUMMATIVE", "FORMATIVE"] } },
      include: {
        category: { select: { code: true } },
        criteria: { include: { criterion: true }, orderBy: { criterion: { code: "asc" } } },
        evaluations: { where: { studentId: { in: studentIds } }, include: { criteria: true } },
        submissions: { where: { studentId: { in: studentIds } } },
      },
      orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
    }),
    db.periodGrade.findMany({ where: { courseId: course.id, periodId, studentId: { in: studentIds } }, include: { criterionGrades: true } }),
    db.categoryWeight.findMany({ where: { periodId }, include: { category: true } }),
    loadPolicy(db, course.programmeId, course.academicYearId),
  ]);
  const weights = weightsFor(weightRows, course.id);
  const ctx: TermContext = {
    criteria: course.subject.criteria.map((c) => ({ id: c.id, code: c.code })),
    assignments: assignments.map((a) => ({
      id: a.id, type: a.type, maxScore: a.maxScore == null ? null : Number(a.maxScore), categoryCode: a.category?.code ?? null, criterionIds: a.criteria.map((c) => c.criterionId),
    })),
    policy: calcPolicyOf(pol),
    weights,
  };

  // ячейки: id ученика → id задания → ячейка (только там, где есть оценка или запись о сдаче)
  const cells: Record<string, Record<string, Cell>> = Object.fromEntries(studentIds.map((sid) => [sid, {}]));
  const evalIdx = new Map<string, EvRow>();
  const missedIdx = new Map<string, Missed>();
  for (const a of assignments) {
    const critIds = a.criteria.map((c) => c.criterionId);
    const subs = new Map(a.submissions.map((s) => [s.studentId, s]));
    const evs = new Map(a.evaluations.map((e) => [e.studentId, e]));
    for (const sid of studentIds) {
      const ev = evs.get(sid);
      const sub = subs.get(sid);
      if (ev || sub) cells[sid][a.id] = toCell(critIds, ev, sub);
      if (ev) evalIdx.set(`${a.id}:${sid}`, ev);
      if (isMissed(sub?.status)) missedIdx.set(`${a.id}:${sid}`, sub!.status === "MISSED_VALID" ? "VALID" : "INVALID");
    }
  }

  const pgByStudent = new Map(pgs.map((p) => [p.studentId, p]));
  const totals: Record<string, RowTotals> = {};
  for (const sid of studentIds) {
    const r = computeStudentTerm(
      ctx,
      (aid) => {
        const e = evalIdx.get(`${aid}:${sid}`);
        return e ? { status: e.status, score: e.score == null ? null : Number(e.score), levels: e.criteria } : undefined;
      },
      (aid) => missedIdx.get(`${aid}:${sid}`) ?? null,
    );
    totals[sid] = toRowTotals(pgByStudent.get(sid), r.categoryPct);
  }
  // категории процентной схемы с ненулевым весом (FORMATIVE, SUMMATIVE, …) — для колонок-расшифровок
  const categories = Object.entries(weights)
    .filter(([, w]) => w > 0)
    .map(([code, weight]) => ({ code, weight, name: weightRows.find((r) => r.category.code === code)!.category.name as unknown }))
    .sort((a, b) => a.code.localeCompare(b.code));
  return { assignments, cells, totals, categories, policy: pol.policy };
}

async function rowTotalsFor(courseId: string, periodId: string | null, studentId: string, categoryPct: Map<string, Record<string, number>>): Promise<RowTotals> {
  if (!periodId) return EMPTY_TOTALS;
  const pg = await db.periodGrade.findUnique({ where: { courseId_studentId_periodId: { courseId, studentId, periodId } }, include: { criterionGrades: true } });
  return toRowTotals(pg, categoryPct.get(`${periodId}:${studentId}`));
}

/**
 * Сохранить изменение одной ячейки журнала и пересчитать итоги ученика.
 * Правила:
 * - пропуск (уважительный или нет) стирает балл и уровни: работа либо не учитывается (EX), либо даёт 0 (0*);
 * - ввод оценки отмечает работу сданной: снимает пропуск (пересдача) и статус «не сдано»;
 * - опубликованная оценка после правки остаётся опубликованной; новая — видна только учителю до публикации;
 * - значения проверяются по максимуму задания (балл) и критерия (уровень).
 */
export async function applyCellPatch(user: CurrentUser, assignmentId: string, studentId: string, patch: CellPatch): Promise<SaveResult> {
  const a = await db.assignment.findUnique({ where: { id: assignmentId }, include: { criteria: true } });
  if (!a || a.deletedAt) return { ok: false, error: "notFound" };
  if (!(await canEditGrades(user, a.courseId, a.periodId))) return { ok: false, error: "forbidden" };
  const enrolled = await db.courseEnrollment.findUnique({ where: { courseId_studentId: { courseId: a.courseId, studentId } }, select: { status: true } });
  if (!enrolled || enrolled.status !== "ACTIVE") return { ok: false, error: "notFound" };

  // ---- проверка значений ----
  const maxScore = a.maxScore == null ? null : Number(a.maxScore);
  let score = patch.score;
  if (score != null) {
    if (maxScore == null) return { ok: false, error: "invalid" };
    if (!Number.isFinite(score) || score < 0 || score > maxScore) return { ok: false, error: "range", max: maxScore };
    score = Math.round(score * 100) / 100;
  }
  const levelPatch = patch.levels ?? {};
  for (const [criterionId, level] of Object.entries(levelPatch)) {
    const ac = a.criteria.find((c) => c.criterionId === criterionId);
    if (!ac) return { ok: false, error: "invalid" };
    if (level != null && (!Number.isInteger(level) || level < 0 || level > ac.maxLevel)) return { ok: false, error: "range", max: ac.maxLevel };
  }
  if (patch.sub !== undefined && !SUB_STATUSES.includes(patch.sub)) return { ok: false, error: "invalid" };
  const comment = patch.comment === undefined ? undefined : patch.comment.trim().slice(0, 2000);

  const key = { assignmentId_studentId: { assignmentId, studentId } };
  const now = new Date();
  const cell = await db.$transaction(async (tx) => {
    const [existing, sub] = await Promise.all([
      tx.evaluation.findUnique({ where: key, include: { criteria: true } }),
      tx.submission.findUnique({ where: key }),
    ]);
    const setsValue = score != null || Object.values(levelPatch).some((l) => l != null);
    // ввод оценки означает, что работа сдана: снимает пропуск (пересдача) и отметку «не сдано»
    const nextSub: SubStatus | undefined = patch.sub ?? (setsValue && (!sub || sub.status === "NOT_SUBMITTED" || isMissed(sub.status)) ? "SUBMITTED" : undefined);
    const missed = isMissed(nextSub ?? sub?.status);

    // ---- новые значения оценки ----
    const levels = new Map<string, number | null>(a.criteria.map((c) => [c.criterionId, existing?.criteria.find((x) => x.criterionId === c.criterionId)?.level ?? null]));
    let nextScore: number | null = existing?.score == null ? null : Number(existing.score);
    if (missed) {
      nextScore = null;
      for (const id of levels.keys()) levels.set(id, null);
    } else {
      if (score !== undefined) nextScore = score;
      for (const [id, level] of Object.entries(levelPatch)) levels.set(id, level);
    }
    const hasData = nextScore != null || [...levels.values()].some((l) => l != null);
    const status: EvStatus = hasData ? (existing?.status === "SHARED" ? "SHARED" : "EVALUATED") : "NOT_EVALUATED";
    const nextComment = comment === undefined ? commentText(existing?.comment) : comment;
    const gradeChanged = !existing
      ? hasData
      : nextScore !== (existing.score == null ? null : Number(existing.score)) ||
        a.criteria.some((c) => (existing.criteria.find((x) => x.criterionId === c.criterionId)?.level ?? null) !== levels.get(c.criterionId));

    let evRow: EvRow | null = existing;
    if (existing || hasData || nextComment) {
      const data = {
        status, score: nextScore,
        comment: nextComment ? { text: nextComment } : Prisma.DbNull,
        sharedAt: status === "SHARED" ? (existing?.sharedAt ?? now) : null,
        ...(gradeChanged || !existing ? { evaluatedById: user.id, evaluatedAt: now } : {}),
      };
      const ev = await tx.evaluation.upsert({ where: key, create: { assignmentId, studentId, ...data }, update: data });
      for (const [criterionId, level] of levels) {
        const had = existing?.criteria.find((x) => x.criterionId === criterionId);
        if (level == null) {
          if (had) await tx.criterionEvaluation.delete({ where: { evaluationId_criterionId: { evaluationId: ev.id, criterionId } } });
        } else if (!had || had.level !== level) {
          await tx.criterionEvaluation.upsert({
            where: { evaluationId_criterionId: { evaluationId: ev.id, criterionId } },
            create: { evaluationId: ev.id, criterionId, level },
            update: { level },
          });
        }
      }
      evRow = { status, score: nextScore, comment: nextComment ? { text: nextComment } : null, criteria: [...levels].map(([criterionId, level]) => ({ criterionId, level })) };
    }

    let subRow: SubRow | null = sub;
    if (nextSub !== undefined && nextSub !== sub?.status) {
      const submitted = nextSub === "SUBMITTED" || nextSub === "LATE";
      subRow = await tx.submission.upsert({
        where: key,
        create: { assignmentId, studentId, status: nextSub, submittedAt: submitted ? now : null, makeupUntil: nextSub === "MISSED_VALID" ? new Date(now.getTime() + MAKEUP_DAYS * DAY) : null },
        update: { status: nextSub, submittedAt: submitted ? (sub?.submittedAt ?? now) : sub?.submittedAt ?? null, makeupUntil: nextSub === "MISSED_VALID" ? new Date(now.getTime() + MAKEUP_DAYS * DAY) : null },
      });
    }
    return toCell(a.criteria.map((c) => c.criterionId), evRow, subRow);
  });

  const { categoryPct } = await recalcCourse(db, a.courseId, [studentId]);
  return { ok: true, cell, totals: await rowTotalsFor(a.courseId, a.periodId, studentId, categoryPct) };
}

/** Уведомления ученикам и их подтверждённым родителям. */
export async function notifyFamilies(studentIds: string[], trigger: string, title: string, entityType: string, entityId: string) {
  if (studentIds.length === 0) return;
  const students = await db.studentProfile.findMany({ where: { id: { in: studentIds } }, include: { guardians: { where: { approved: true }, include: { guardian: true } } } });
  const data = students.flatMap((s) => [
    { recipientId: s.userId, trigger, title, entityType, entityId },
    ...s.guardians.map((g) => ({ recipientId: g.guardian.userId, trigger, title, entityType, entityId })),
  ]);
  if (data.length) await db.notification.createMany({ data });
}

/**
 * Опубликовать оценки задания ученикам и родителям (publish=true) или скрыть их обратно (publish=false).
 * Публикуются только выставленные оценки. Возвращает число затронутых оценок или null, если нет прав.
 */
export async function setAssignmentShared(user: CurrentUser, assignmentId: string, publish: boolean): Promise<{ courseId: string; period: string | null; count: number } | null> {
  const a = await db.assignment.findUnique({ where: { id: assignmentId }, include: { period: true, course: { select: { schoolId: true, name: true } } } });
  if (!a || a.deletedAt) return null;
  if (!(await canEditGrades(user, a.courseId, a.periodId))) return null;
  const from: EvStatus = publish ? "EVALUATED" : "SHARED";
  const rows = await db.evaluation.findMany({ where: { assignmentId, status: from }, select: { id: true, studentId: true } });
  if (rows.length) {
    await db.evaluation.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: publish ? { status: "SHARED", sharedAt: new Date() } : { status: "EVALUATED", sharedAt: null } });
    if (publish) await notifyFamilies(rows.map((r) => r.studentId), "GRADE_PUBLISHED", `Опубликована оценка: ${a.title}`, "Assignment", a.id);
    await db.auditLog.create({
      data: { schoolId: a.course.schoolId, actorId: user.id, action: publish ? "ASSIGNMENT_PUBLISH" : "ASSIGNMENT_UNPUBLISH", entityType: "Assignment", entityId: a.id, meta: { title: a.title, course: a.course.name, count: rows.length } },
    });
  }
  return { courseId: a.courseId, period: a.period?.abbreviation ?? null, count: rows.length };
}
