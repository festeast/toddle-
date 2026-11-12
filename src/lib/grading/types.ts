/**
 * Типы журнала, общие для сервера и браузера (только данные, без кода).
 */
export type SubStatus = "NOT_SUBMITTED" | "SUBMITTED" | "LATE" | "RETURNED" | "MISSED_VALID" | "MISSED_INVALID";
export type EvStatus = "NOT_EVALUATED" | "DRAFT" | "EVALUATED" | "SHARED";

/** Ячейка журнала: оценка одного ученика за одно задание. */
export type Cell = {
  /** балл (для балльных заданий) */
  score: number | null;
  /** уровни по критериям задания: id критерия → уровень */
  levels: Record<string, number | null>;
  ev: EvStatus;
  /** статус сдачи; NOT_SUBMITTED, если записи о сдаче ещё нет */
  sub: SubStatus;
  comment: string;
  /** до какой даты пересдача при пропуске по уважительной причине (ISO) */
  makeupUntil: string | null;
};

export const EMPTY_CELL: Cell = { score: null, levels: {}, ev: "NOT_EVALUATED", sub: "NOT_SUBMITTED", comment: "", makeupUntil: null };

/** Итог ученика за период (строка журнала). */
export type RowTotals = {
  /** id строки PeriodGrade (для ручного переопределения); null, пока итог не рассчитан */
  pgId: string | null;
  overallPct: number | null;
  /** действующая оценка 1–7: ручное значение важнее расчёта */
  grade7: number | null;
  /** расчётная оценка 1–7 (до переопределения) */
  calc7: number | null;
  grade5: number | null;
  overridden: boolean;
  published: boolean;
  /** итоговые уровни критериев за период: id критерия → уровень */
  criteria: Record<string, number | null>;
  criteriaSum: number | null;
  criteriaCount: number | null;
  /** средний процент по категориям (расшифровка процентной схемы): код категории → % */
  categoryPct: Record<string, number>;
};

export const EMPTY_TOTALS: RowTotals = {
  pgId: null, overallPct: null, grade7: null, calc7: null, grade5: null, overridden: false, published: false,
  criteria: {}, criteriaSum: null, criteriaCount: null, categoryPct: {},
};

/** Изменение ячейки. Поля, которых нет в объекте, не меняются. */
export type CellPatch = {
  score?: number | null;
  levels?: Record<string, number | null>;
  sub?: SubStatus;
  comment?: string;
};

export type SaveError = "forbidden" | "notFound" | "range" | "invalid";
export type SaveResult =
  | { ok: true; cell: Cell; totals: RowTotals }
  | { ok: false; error: SaveError; max?: number };

/** Колонка журнала: задание. */
export type GbColumn = {
  id: string;
  title: string;
  type: "SUMMATIVE" | "FORMATIVE";
  /** срок: готовая строка для показа и ISO для сортировки */
  due: string;
  dueIso: string | null;
  maxScore: number | null;
  categoryCode: string | null;
  criteria: { id: string; code: string; name: string; maxLevel: number }[];
  /** входит ли работа в критериальный итог (формативные — только если разрешено политикой) */
  countsForCriteria: boolean;
};

export type GbStudent = { id: string; name: string };
