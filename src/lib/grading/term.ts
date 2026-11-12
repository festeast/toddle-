/**
 * Сбор входных данных ученика за reporting-период и расчёт итога — чистые функции без БД.
 * Одна и та же логика используется пересчётом (service.ts) и журналом (расшифровка по категориям),
 * поэтому правила «что считается, а что нет» описаны только здесь.
 */
import { computeTermGrade, type Aggregation, type BoundarySets, type PercentBand, type TermResult } from "./engine";

export type CalcAssignment = {
  id: string;
  type: string; // SUMMATIVE | FORMATIVE | …
  maxScore: number | null;
  categoryCode: string | null;
  criterionIds: string[];
};

export type CalcEval = {
  status: string; // NOT_EVALUATED | DRAFT | EVALUATED | SHARED
  score: number | null;
  levels: { criterionId: string; level: number | null }[];
};

export type CalcPolicy = {
  aggregation: Aggregation;
  boundarySets: BoundarySets;
  percentBands: PercentBand[];
  useCriteriaMethod: boolean;
  usePercentMethod: boolean;
  allowFormativeInFinal: boolean;
};

export type TermContext = {
  /** критерии предмета (в порядке A, B, C, D) */
  criteria: { id: string; code: string }[];
  /** задания периода в хронологическом порядке */
  assignments: CalcAssignment[];
  policy: CalcPolicy;
  /** веса категорий периода: код категории → вес */
  weights: Record<string, number>;
};

/** Статус пропуска работы: уважительная причина исключает работу из расчёта, неуважительная даёт 0. */
export type Missed = "VALID" | "INVALID" | null;

export const isCounted = (status: string | undefined | null) => status === "EVALUATED" || status === "SHARED";

/** Веса категорий периода: значение курса важнее общего значения периода. */
export function weightsFor(
  rows: { courseId: string | null; weight: number | { toString(): string }; category: { code: string } }[],
  courseId: string,
): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const cw of rows.filter((w) => w.courseId === null || w.courseId === courseId)) {
    if (cw.courseId === courseId || !(cw.category.code in weights)) weights[cw.category.code] = Number(cw.weight);
  }
  return weights;
}

/**
 * Итог ученика за период.
 * - пропуск по неуважительной причине → 0 по всем критериям работы и 0 % по балльной работе;
 * - пропуск по уважительной причине → работа не учитывается (до пересдачи);
 * - учитываются только оценённые работы (EVALUATED / SHARED);
 * - формативные работы входят в критериальный итог только если это разрешено политикой;
 * - балльные работы (maxScore + категория) входят в процентную схему с весами категорий.
 */
export function computeStudentTerm(
  ctx: TermContext,
  evalOf: (assignmentId: string) => CalcEval | undefined,
  missedOf: (assignmentId: string) => Missed,
): TermResult {
  const buckets = new Map(ctx.criteria.map((c) => [c.id, [] as number[]]));
  const percentItems: { category: string; pct: number }[] = [];
  for (const a of ctx.assignments) {
    const missed = missedOf(a.id);
    if (missed === "VALID") continue;
    const ev = evalOf(a.id);
    const counted = isCounted(ev?.status);
    if (a.type === "SUMMATIVE" || ctx.policy.allowFormativeInFinal) {
      for (const criterionId of a.criterionIds) {
        const bucket = buckets.get(criterionId);
        if (!bucket) continue;
        if (missed === "INVALID") bucket.push(0);
        else if (counted) {
          const lvl = ev!.levels.find((x) => x.criterionId === criterionId)?.level;
          if (lvl != null) bucket.push(lvl);
        }
      }
    }
    if (a.maxScore && a.categoryCode) {
      if (missed === "INVALID") percentItems.push({ category: a.categoryCode, pct: 0 });
      else if (counted && ev!.score != null) percentItems.push({ category: a.categoryCode, pct: (ev!.score / a.maxScore) * 100 });
    }
  }
  return computeTermGrade({
    criteria: ctx.criteria.map((c) => ({ code: c.code, levels: buckets.get(c.id)! })),
    aggregation: ctx.policy.aggregation,
    boundarySets: ctx.policy.boundarySets,
    percentItems,
    categoryWeights: ctx.weights,
    percentBands: ctx.policy.percentBands,
    useCriteriaMethod: ctx.policy.useCriteriaMethod,
    usePercentMethod: ctx.policy.usePercentMethod,
  });
}
