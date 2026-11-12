import { describe, it, expect } from "vitest";
import { computeStudentTerm, weightsFor, type CalcEval, type Missed, type TermContext } from "@/lib/grading/term";
import { MYP_BOUNDARIES, PERCENT_BANDS } from "@/lib/grading/defaults";

const policy = { aggregation: "MEAN_ROUND_HALF_UP" as const, boundarySets: MYP_BOUNDARIES, percentBands: PERCENT_BANDS, useCriteriaMethod: true, usePercentMethod: true, allowFormativeInFinal: false };
const weights = { FORMATIVE: 25, SUMMATIVE: 75 };
const run = (ctx: TermContext, evals: Record<string, CalcEval>, missed: Record<string, Missed> = {}) =>
  computeStudentTerm(ctx, (id) => evals[id], (id) => missed[id] ?? null);
const ev = (score: number | null, levels: Record<string, number> = {}, status = "EVALUATED"): CalcEval =>
  ({ status, score, levels: Object.entries(levels).map(([criterionId, level]) => ({ criterionId, level })) });

describe("computeStudentTerm — DP (баллы)", () => {
  const ctx: TermContext = {
    criteria: [],
    assignments: [
      { id: "quiz", type: "FORMATIVE", maxScore: 10, categoryCode: "FORMATIVE", criterionIds: [] },
      { id: "test", type: "SUMMATIVE", maxScore: 50, categoryCode: "SUMMATIVE", criterionIds: [] },
    ],
    policy: { ...policy, useCriteriaMethod: false },
    weights,
  };
  it("25 % формативных + 75 % суммативных", () => {
    const r = run(ctx, { quiz: ev(7), test: ev(40) });
    expect(r.categoryPct).toEqual({ FORMATIVE: 70, SUMMATIVE: 80 });
    expect(r.overallPct).toBe(77.5);
    expect(r.grade7).toBe(6);
  });
  it("пропуск по неуважительной причине — 0 % за работу", () => {
    const r = run(ctx, { quiz: ev(7) }, { test: "INVALID" });
    expect(r.categoryPct).toEqual({ FORMATIVE: 70, SUMMATIVE: 0 });
    expect(r.overallPct).toBe(17.5);
    expect(r.grade7).toBe(2);
  });
  it("пропуск по уважительной причине — работа не учитывается, даже если балл остался", () => {
    const r = run(ctx, { quiz: ev(5), test: ev(45) }, { test: "VALID" });
    expect(r.categoryPct).toEqual({ FORMATIVE: 50 });
    expect(r.overallPct).toBe(50);
  });
  it("неоценённые и черновые работы не учитываются", () => {
    expect(run(ctx, { quiz: ev(7, {}, "NOT_EVALUATED"), test: ev(40, {}, "DRAFT") }).overallPct).toBeNull();
    expect(run(ctx, {}).grade7).toBeNull();
  });
  it("опубликованные и неопубликованные оценки считаются одинаково", () => {
    expect(run(ctx, { test: ev(40, {}, "SHARED") }).overallPct).toBe(80);
    expect(run(ctx, { test: ev(40, {}, "EVALUATED") }).overallPct).toBe(80);
  });
});

describe("computeStudentTerm — MYP (критерии)", () => {
  const criteria = ["A", "B", "C", "D"].map((code) => ({ id: code.toLowerCase(), code }));
  const ctx: TermContext = {
    criteria,
    assignments: [
      { id: "fa", type: "FORMATIVE", maxScore: null, categoryCode: "FORMATIVE", criterionIds: ["a"] },
      { id: "sa1", type: "SUMMATIVE", maxScore: null, categoryCode: "SUMMATIVE", criterionIds: ["a", "b"] },
      { id: "sa2", type: "SUMMATIVE", maxScore: null, categoryCode: "SUMMATIVE", criterionIds: ["c", "d"] },
    ],
    policy,
    weights,
  };
  it("формативные не входят в итог по критериям", () => {
    const r = run(ctx, { fa: ev(null, { a: 1 }), sa1: ev(null, { a: 6, b: 6 }), sa2: ev(null, { c: 5, d: 7 }) });
    expect(r.criterionLevels).toEqual({ A: 6, B: 6, C: 5, D: 7 });
    expect(r.criteriaSum).toBe(24);
    expect(r.grade7).toBe(6);
    expect(r.method).toBe("CRITERIA");
  });
  it("формативные входят, если это разрешено политикой", () => {
    const r = run({ ...ctx, policy: { ...policy, allowFormativeInFinal: true } }, { fa: ev(null, { a: 2 }), sa1: ev(null, { a: 6, b: 6 }) });
    expect(r.criterionLevels.A).toBe(4); // (2 + 6) / 2
  });
  it("пропуск по неуважительной причине — 0 по каждому критерию работы", () => {
    const r = run(ctx, { sa2: ev(null, { c: 5, d: 7 }) }, { sa1: "INVALID" });
    expect(r.criterionLevels).toEqual({ A: 0, B: 0, C: 5, D: 7 });
    expect(r.criteriaSum).toBe(12);
    expect(r.grade7).toBe(3);
  });
  it("пропуск по уважительной причине — критерии работы остаются неоценёнными", () => {
    const r = run(ctx, { sa2: ev(null, { c: 5, d: 7 }) }, { sa1: "VALID" });
    expect(r.criterionLevels).toEqual({ A: null, B: null, C: 5, D: 7 });
    expect(r.criteriaCount).toBe(2);
    expect(r.grade7).toBe(6); // таблица для двух критериев: 12 → 6
  });
});

describe("weightsFor", () => {
  const rows = [
    { courseId: null, weight: 25, category: { code: "FORMATIVE" } },
    { courseId: null, weight: 75, category: { code: "SUMMATIVE" } },
    { courseId: "c1", weight: 40, category: { code: "FORMATIVE" } },
    { courseId: "c2", weight: 10, category: { code: "FORMATIVE" } },
  ];
  it("значение курса важнее общего значения периода", () => {
    expect(weightsFor(rows, "c1")).toEqual({ FORMATIVE: 40, SUMMATIVE: 75 });
    expect(weightsFor(rows, "other")).toEqual({ FORMATIVE: 25, SUMMATIVE: 75 });
    expect(weightsFor([...rows].reverse(), "c1")).toEqual({ FORMATIVE: 40, SUMMATIVE: 75 });
  });
});
