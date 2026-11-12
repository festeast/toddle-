/**
 * Разбор того, что учитель ввёл в ячейку журнала. Чистая функция: используется и в браузере, и в тестах.
 * Сервер всё равно проверяет значения ещё раз (src/lib/grading/gradebook.ts).
 */
export type ParsedInput =
  | { kind: "clear" }
  | { kind: "value"; value: number }
  | { kind: "missed"; status: "MISSED_VALID" | "MISSED_INVALID" }
  | { kind: "error"; code: "range" | "format" | "integer" };

/** Что показывается в ячейке при пропуске работы. */
export const MISSED_LABEL = { MISSED_VALID: "EX", MISSED_INVALID: "0*" } as const;

// EX латиницей или кириллицей (ЕХ — те же клавиши в русской раскладке), а также «ув»
const EXCUSED = /^(ex|ех|eх|еx|ув|уваж)\.?$/i;
// 0* — пропуск без уважительной причины. Короткие пометки вроде «н» намеренно не принимаются:
// они обнуляют работу, поэтому ввод должен быть явным.
const UNEXCUSED = /^(0\*|неуваж)\.?$/i;

/**
 * @param raw     текст из ячейки
 * @param max     максимальный балл или максимальный уровень критерия
 * @param integer true для уровней критериев (только целые), false для баллов (до 2 знаков после запятой)
 */
export function parseGradeInput(raw: string, max: number, integer: boolean): ParsedInput {
  const s = raw.trim();
  if (s === "" || s === "-" || s === "—" || s === "·") return { kind: "clear" };
  if (EXCUSED.test(s)) return { kind: "missed", status: "MISSED_VALID" };
  if (UNEXCUSED.test(s)) return { kind: "missed", status: "MISSED_INVALID" };
  const norm = s.replace(",", ".");
  if (!/^\d{1,5}(\.\d{0,2})?$/.test(norm)) return { kind: "error", code: "format" };
  const n = Number(norm);
  if (!Number.isFinite(n)) return { kind: "error", code: "format" };
  if (integer && !Number.isInteger(n)) return { kind: "error", code: "integer" };
  if (n < 0 || n > max) return { kind: "error", code: "range" };
  return { kind: "value", value: n };
}

/** Балл для показа: без хвостовых нулей (7, 7.5, 12.25). */
export function fmtScore(n: number | null | undefined): string {
  if (n == null) return "";
  return String(Math.round(n * 100) / 100);
}

/** Процент для показа: два знака, как в Toddle (64.17). */
export function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toFixed(2);
}
