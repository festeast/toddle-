import { describe, it, expect } from "vitest";
import { parseGradeInput, fmtScore, fmtPct } from "@/lib/grading/input";

describe("parseGradeInput — баллы", () => {
  it("числа: целые, дробные, с запятой", () => {
    expect(parseGradeInput("40", 50, false)).toEqual({ kind: "value", value: 40 });
    expect(parseGradeInput(" 45,5 ", 50, false)).toEqual({ kind: "value", value: 45.5 });
    expect(parseGradeInput("12.25", 50, false)).toEqual({ kind: "value", value: 12.25 });
    expect(parseGradeInput("0", 50, false)).toEqual({ kind: "value", value: 0 });
    expect(parseGradeInput("50", 50, false)).toEqual({ kind: "value", value: 50 });
  });
  it("пустое значение стирает оценку", () => {
    for (const s of ["", "  ", "-", "—"]) expect(parseGradeInput(s, 50, false)).toEqual({ kind: "clear" });
  });
  it("вне диапазона и не число", () => {
    expect(parseGradeInput("51", 50, false)).toEqual({ kind: "error", code: "range" });
    expect(parseGradeInput("-1", 50, false)).toEqual({ kind: "error", code: "format" });
    expect(parseGradeInput("abc", 50, false)).toEqual({ kind: "error", code: "format" });
    expect(parseGradeInput("1.234", 50, false)).toEqual({ kind: "error", code: "format" });
    expect(parseGradeInput("1e3", 5000, false)).toEqual({ kind: "error", code: "format" });
  });
});

describe("parseGradeInput — уровни критериев", () => {
  it("только целые 0–max", () => {
    expect(parseGradeInput("8", 8, true)).toEqual({ kind: "value", value: 8 });
    expect(parseGradeInput("9", 8, true)).toEqual({ kind: "error", code: "range" });
    expect(parseGradeInput("5.5", 8, true)).toEqual({ kind: "error", code: "integer" });
    expect(parseGradeInput("5.0", 8, true)).toEqual({ kind: "value", value: 5 });
  });
});

describe("parseGradeInput — пропуски", () => {
  it("EX в любой раскладке — уважительная причина", () => {
    for (const s of ["EX", "ex", "Ех", "ех", "ув", "уваж."]) expect(parseGradeInput(s, 50, false)).toEqual({ kind: "missed", status: "MISSED_VALID" });
  });
  it("0* — неуважительная причина", () => {
    expect(parseGradeInput("0*", 8, true)).toEqual({ kind: "missed", status: "MISSED_INVALID" });
    expect(parseGradeInput("неуваж", 50, false)).toEqual({ kind: "missed", status: "MISSED_INVALID" });
  });
  it("короткие пометки вроде «н» не принимаются: обнулять работу можно только явно", () => {
    expect(parseGradeInput("н", 50, false)).toEqual({ kind: "error", code: "format" });
    expect(parseGradeInput("нб", 50, false)).toEqual({ kind: "error", code: "format" });
  });
});

describe("формат показа", () => {
  it("балл без хвостовых нулей", () => {
    expect(fmtScore(7)).toBe("7");
    expect(fmtScore(7.5)).toBe("7.5");
    expect(fmtScore(12.25)).toBe("12.25");
    expect(fmtScore(null)).toBe("");
  });
  it("процент с двумя знаками", () => {
    expect(fmtPct(64.17)).toBe("64.17");
    expect(fmtPct(50)).toBe("50.00");
    expect(fmtPct(null)).toBe("—");
  });
});
