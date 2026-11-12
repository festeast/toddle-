/**
 * Интеграционные тесты журнала на seed-данных (нужна БД: npm run db:reset).
 * Проверяют сохранение ячейки, пересчёт итогов, пропуски, права и публикацию оценок задания.
 * Тест возвращает базу в исходное состояние: затронутые оценки и сдачи восстанавливаются.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { loadUser, type CurrentUser } from "@/lib/auth";
import { applyCellPatch, setAssignmentShared } from "@/lib/grading/gradebook";
import { recalcCourse } from "@/lib/grading/service";

const byEmail = async (email: string) => (await loadUser((await db.user.findFirstOrThrow({ where: { email } })).id))!;
type Snapshot = { assignmentId: string; studentId: string; ev: Awaited<ReturnType<typeof readEval>>; sub: Awaited<ReturnType<typeof readSub>> };
const readEval = (assignmentId: string, studentId: string) => db.evaluation.findUnique({ where: { assignmentId_studentId: { assignmentId, studentId } }, include: { criteria: true } });
const readSub = (assignmentId: string, studentId: string) => db.submission.findUnique({ where: { assignmentId_studentId: { assignmentId, studentId } } });

let physTeacher: CurrentUser, mathTeacher: CurrentUser, student: CurrentUser;
let dpCourse: string, mypCourse: string, studentDp: string, studentMyp: string;
let dpTest: string, dpLocked: string, mypSummative: string, critB: string, critC: string, critA: string;
const snapshots: Snapshot[] = [];
const startedAt = new Date();

async function snapshot(assignmentId: string, studentId: string) {
  snapshots.push({ assignmentId, studentId, ev: await readEval(assignmentId, studentId), sub: await readSub(assignmentId, studentId) });
}

beforeAll(async () => {
  physTeacher = await byEmail("physics@demo.school");
  mathTeacher = await byEmail("math@demo.school");
  const dp = await db.course.findFirstOrThrow({ where: { name: { startsWith: "DP1 Physics" } }, include: { enrollments: { orderBy: { studentId: "asc" } } } });
  const myp = await db.course.findFirstOrThrow({ where: { name: "7A Mathematics" }, include: { enrollments: { orderBy: { studentId: "asc" } } } });
  dpCourse = dp.id;
  mypCourse = myp.id;
  studentDp = dp.enrollments[0].studentId;
  studentMyp = myp.enrollments[0].studentId;
  student = (await loadUser((await db.studentProfile.findUniqueOrThrow({ where: { id: studentDp } })).userId))!;
  // DP, открытый T2: суммативная /50 без оценок в демо-данных; DP, заблокированный T1
  dpTest = (await db.assignment.findFirstOrThrow({ where: { courseId: dpCourse, type: "SUMMATIVE", period: { abbreviation: "T2" }, deletedAt: null } })).id;
  dpLocked = (await db.assignment.findFirstOrThrow({ where: { courseId: dpCourse, type: "SUMMATIVE", period: { abbreviation: "T1" }, deletedAt: null } })).id;
  // MYP, открытый T2: суммативная по критериям B и C без оценок в демо-данных
  const sa = await db.assignment.findFirstOrThrow({
    where: { courseId: mypCourse, type: "SUMMATIVE", period: { abbreviation: "T2" }, deletedAt: null, criteria: { some: { criterion: { code: "B" } } } },
    include: { criteria: { include: { criterion: true } } },
  });
  mypSummative = sa.id;
  critB = sa.criteria.find((c) => c.criterion.code === "B")!.criterionId;
  critC = sa.criteria.find((c) => c.criterion.code === "C")!.criterionId;
  critA = (await db.criterion.findFirstOrThrow({ where: { subjectId: myp.subjectId, code: "A" } })).id;
  await snapshot(dpTest, studentDp);
  await snapshot(mypSummative, studentMyp);
});

afterAll(async () => {
  // вернуть затронутые ячейки в исходное состояние
  for (const s of snapshots) {
    await db.evaluation.deleteMany({ where: { assignmentId: s.assignmentId, studentId: s.studentId } });
    await db.submission.deleteMany({ where: { assignmentId: s.assignmentId, studentId: s.studentId } });
    if (s.ev) {
      const { criteria, comment, ...ev } = s.ev;
      await db.evaluation.create({ data: { ...ev, comment: comment ?? Prisma.DbNull, criteria: { create: criteria.map((c) => ({ criterionId: c.criterionId, level: c.level, comment: c.comment })) } } });
    }
    if (s.sub) {
      const { body, ...sub } = s.sub;
      await db.submission.create({ data: { ...sub, body: body ?? Prisma.DbNull } });
    }
  }
  await db.notification.deleteMany({ where: { entityType: "Assignment", entityId: { in: [dpTest, mypSummative] }, createdAt: { gte: startedAt } } });
  await db.auditLog.deleteMany({ where: { entityType: "Assignment", entityId: { in: [dpTest, mypSummative] }, createdAt: { gte: startedAt } } });
  await recalcCourse(db, dpCourse, [studentDp]);
  await recalcCourse(db, mypCourse, [studentMyp]);
  await db.$disconnect();
});

describe("сохранение ячейки — баллы (DP)", () => {
  it("балл сохраняется, работа отмечается сданной, итог пересчитывается", async () => {
    const res = await applyCellPatch(physTeacher, dpTest, studentDp, { score: 40 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cell).toMatchObject({ score: 40, ev: "EVALUATED", sub: "SUBMITTED" });
    expect(res.totals.categoryPct.SUMMATIVE).toBe(80);
    expect(res.totals.overallPct).not.toBeNull();
    expect(res.totals.grade7).not.toBeNull();
    const pg = await db.periodGrade.findUniqueOrThrow({ where: { id: res.totals.pgId! } });
    expect(Number(pg.overallPct)).toBe(res.totals.overallPct);
  });
  it("балл выше максимума отклоняется, в базе ничего не меняется", async () => {
    const res = await applyCellPatch(physTeacher, dpTest, studentDp, { score: 51 });
    expect(res).toEqual({ ok: false, error: "range", max: 50 });
    expect(Number((await readEval(dpTest, studentDp))!.score)).toBe(40);
  });
  it("пропуск по неуважительной причине стирает балл и даёт 0 %", async () => {
    const res = await applyCellPatch(physTeacher, dpTest, studentDp, { sub: "MISSED_INVALID" });
    expect(res.ok && res.cell).toMatchObject({ score: null, ev: "NOT_EVALUATED", sub: "MISSED_INVALID" });
    expect(res.ok && res.totals.categoryPct.SUMMATIVE).toBe(0);
  });
  it("ввод оценки снимает пропуск", async () => {
    const res = await applyCellPatch(physTeacher, dpTest, studentDp, { score: 25 });
    expect(res.ok && res.cell).toMatchObject({ score: 25, ev: "EVALUATED", sub: "SUBMITTED" });
    expect(res.ok && res.totals.categoryPct.SUMMATIVE).toBe(50);
  });
  it("пропуск по уважительной причине исключает работу из расчёта и задаёт срок пересдачи", async () => {
    const res = await applyCellPatch(physTeacher, dpTest, studentDp, { sub: "MISSED_VALID" });
    expect(res.ok && res.cell).toMatchObject({ score: null, sub: "MISSED_VALID" });
    expect(res.ok && res.cell.makeupUntil).toBeTruthy();
    expect(res.ok && "SUMMATIVE" in res.totals.categoryPct).toBe(false);
  });
  it("комментарий сохраняется и стирается", async () => {
    let res = await applyCellPatch(physTeacher, dpTest, studentDp, { score: 30, comment: "  Хорошо  " });
    expect(res.ok && res.cell.comment).toBe("Хорошо");
    res = await applyCellPatch(physTeacher, dpTest, studentDp, { comment: "" });
    expect(res.ok && res.cell).toMatchObject({ comment: "", score: 30 });
    expect((await readEval(dpTest, studentDp))!.comment).toBeNull();
  });
});

describe("права", () => {
  it("учитель чужого курса и ученик не могут менять оценки", async () => {
    expect(await applyCellPatch(mathTeacher, dpTest, studentDp, { score: 1 })).toEqual({ ok: false, error: "forbidden" });
    expect(await applyCellPatch(student, dpTest, studentDp, { score: 50 })).toEqual({ ok: false, error: "forbidden" });
  });
  it("учитель не меняет оценки в заблокированном периоде", async () => {
    expect(await applyCellPatch(physTeacher, dpLocked, studentDp, { score: 1 })).toEqual({ ok: false, error: "forbidden" });
    expect(await setAssignmentShared(physTeacher, dpLocked, false)).toBeNull();
  });
  it("ученик другого курса не принимается", async () => {
    expect(await applyCellPatch(physTeacher, dpTest, studentMyp, { score: 10 })).toEqual({ ok: false, error: "notFound" });
  });
});

describe("сохранение ячейки — уровни критериев (MYP)", () => {
  it("уровни сохраняются по одному и входят в итог периода", async () => {
    let res = await applyCellPatch(mathTeacher, mypSummative, studentMyp, { levels: { [critB]: 6 } });
    expect(res.ok && res.cell.levels).toEqual({ [critB]: 6, [critC]: null });
    res = await applyCellPatch(mathTeacher, mypSummative, studentMyp, { levels: { [critC]: 7 } });
    expect(res.ok && res.cell.levels).toEqual({ [critB]: 6, [critC]: 7 });
    expect(res.ok && res.totals.criteria[critB]).toBe(6);
    expect(res.ok && res.totals.criteria[critC]).toBe(7);
    expect(res.ok && res.totals.criteriaSum).not.toBeNull();
  });
  it("уровень вне шкалы и чужой критерий отклоняются", async () => {
    expect(await applyCellPatch(mathTeacher, mypSummative, studentMyp, { levels: { [critB]: 9 } })).toEqual({ ok: false, error: "range", max: 8 });
    expect(await applyCellPatch(mathTeacher, mypSummative, studentMyp, { levels: { [critA]: 5 } })).toEqual({ ok: false, error: "invalid" });
    expect(await applyCellPatch(mathTeacher, mypSummative, studentMyp, { score: 5 })).toEqual({ ok: false, error: "invalid" });
  });
  it("стирание всех уровней возвращает ячейку в «не оценено»", async () => {
    const res = await applyCellPatch(mathTeacher, mypSummative, studentMyp, { levels: { [critB]: null, [critC]: null } });
    expect(res.ok && res.cell).toMatchObject({ ev: "NOT_EVALUATED", levels: { [critB]: null, [critC]: null } });
  });
});

describe("публикация оценок задания", () => {
  it("публикуются только выставленные оценки; правка опубликованной оценки оставляет её опубликованной", async () => {
    await applyCellPatch(physTeacher, dpTest, studentDp, { score: 35 });
    const before = await db.evaluation.count({ where: { assignmentId: dpTest, status: "EVALUATED" } });
    const pub = await setAssignmentShared(physTeacher, dpTest, true);
    expect(pub?.count).toBe(before);
    expect((await readEval(dpTest, studentDp))!.status).toBe("SHARED");
    const edited = await applyCellPatch(physTeacher, dpTest, studentDp, { score: 36 });
    expect(edited.ok && edited.cell.ev).toBe("SHARED");
    const hidden = await setAssignmentShared(physTeacher, dpTest, false);
    expect(hidden?.count).toBe(before);
    expect((await readEval(dpTest, studentDp))!.status).toBe("EVALUATED");
  });
  it("чужой учитель не может публиковать", async () => {
    expect(await setAssignmentShared(mathTeacher, dpTest, true)).toBeNull();
  });
});
