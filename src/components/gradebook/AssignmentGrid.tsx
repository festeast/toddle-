"use client";
/**
 * Оценки одного задания: ученики по строкам; статус сдачи, уровни/балл и комментарий — в строке.
 * Тот же ввод и автосохранение, что и в журнале курса.
 */
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui";
import { setAssignmentPublished } from "@/app/actions/grading";
import { fmtPct, fmtScore, MISSED_LABEL, parseGradeInput } from "@/lib/grading/input";
import { EMPTY_CELL, type Cell, type CellPatch, type GbColumn, type GbStudent, type SubStatus } from "@/lib/grading/types";
import type { Loc } from "@/lib/i18n-dict";
import { bumpSaveRev, cellHasData, ErrorBanner, focusGridCell, GradeInput, isMissed, markSubmitted, SaveIndicator, useCellSaver, useStaleRefresh, useT } from "./shared";

const STATUSES: SubStatus[] = ["SUBMITTED", "LATE", "NOT_SUBMITTED", "MISSED_VALID", "MISSED_INVALID"];
const levelTone = (v: number) => (v >= 7 ? "text-emerald-700" : v >= 5 ? "text-green-700" : v >= 3 ? "text-amber-700" : "text-red-700");

export function AssignmentGrid(props: { version: number; locale: Loc; canEdit: boolean; assignment: GbColumn; students: GbStudent[]; cells: Record<string, Cell> }) {
  const { locale, canEdit, assignment: a, students } = props;
  const t = useT(locale);
  const empty = useMemo<Cell>(() => ({ ...EMPTY_CELL, levels: Object.fromEntries(a.criteria.map((c) => [c.id, null])) }), [a.criteria]);

  const [version, setVersion] = useState(props.version);
  const [cells, setCells] = useState(props.cells);
  if (version !== props.version) {
    setVersion(props.version);
    setCells(props.cells);
  }
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const nameOf = useMemo(() => new Map(students.map((s) => [s.id, s.name])), [students]);
  const [notice, setNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);

  const saver = useCellSaver({
    t,
    label: (_aid, sid) => nameOf.get(sid) ?? "",
    current: (_aid, sid) => cellsRef.current[sid] ?? empty,
    apply: (_aid, sid, cell) => setCells((prev) => ({ ...prev, [sid]: cell })),
  });
  const stale = useStaleRefresh(props.version, saver.pending > 0);

  const edit = (studentId: string, patch: CellPatch, change: (cur: Cell) => Cell) => {
    const cur = cellsRef.current[studentId] ?? empty;
    const next = change(cur);
    next.ev = cellHasData(next) ? (cur.ev === "SHARED" ? "SHARED" : "EVALUATED") : "NOT_EVALUATED";
    saver.save(a.id, studentId, patch, next);
  };
  const setStatus = (studentId: string, status: SubStatus) => {
    const cur = cellsRef.current[studentId] ?? empty;
    if (isMissed(status) && cellHasData(cur) && !window.confirm(t("confirmMissed"))) return false;
    edit(studentId, { sub: status }, (c) => isMissed(status)
      ? { ...empty, sub: status, comment: c.comment, makeupUntil: status === "MISSED_VALID" ? new Date(Date.now() + 7 * 86400000).toISOString() : null }
      : { ...c, sub: status, makeupUntil: null });
    return true;
  };
  /** Ввод в поле оценки: число, пусто, EX или 0*. Возвращает текст ошибки или null. */
  const commitGrade = (studentId: string, raw: string, target: { criterionId: string; max: number } | { max: number }): string | null => {
    const level = "criterionId" in target;
    const parsed = parseGradeInput(raw, target.max, level);
    if (parsed.kind === "error") return parsed.code === "range" ? `${t("errRange")} ${fmtScore(target.max)}` : parsed.code === "integer" ? t("errInteger") : t("errFormat");
    const cur = cellsRef.current[studentId] ?? empty;
    if (parsed.kind === "missed") {
      edit(studentId, { sub: parsed.status }, (c) => ({ ...empty, sub: parsed.status, comment: c.comment }));
    } else if (parsed.kind === "clear" && isMissed(cur.sub)) {
      edit(studentId, { sub: "NOT_SUBMITTED" }, (c) => ({ ...c, sub: "NOT_SUBMITTED", makeupUntil: null }));
    } else {
      const value = parsed.kind === "value" ? parsed.value : null;
      const base = (c: Cell): Cell => (value != null ? markSubmitted(c) : c);
      if (level) edit(studentId, { levels: { [target.criterionId]: value } }, (c) => ({ ...base(c), levels: { ...c.levels, [target.criterionId]: value } }));
      else edit(studentId, { score: value }, (c) => ({ ...base(c), score: value }));
    }
    return null;
  };

  const publish = async (on: boolean) => {
    setBulk(true);
    setNotice(null);
    setLocalError(null);
    try {
      const res = await setAssignmentPublished(a.id, on);
      if (!res.ok) return setLocalError(t(res.error === "forbidden" ? "errForbidden" : "errInvalid"));
      setCells((prev) => Object.fromEntries(Object.entries(prev).map(([sid, c]) => [sid, (on ? c.ev === "EVALUATED" : c.ev === "SHARED") ? { ...c, ev: on ? "SHARED" : "EVALUATED" } : c])));
      bumpSaveRev();
      setNotice(`${t(on ? "gradesPublished" : "gradesHidden")} (${res.count})`);
    } catch {
      setLocalError(t("errNetwork"));
    } finally {
      setBulk(false);
    }
  };

  const stats = useMemo(() => {
    let evaluated = 0;
    let shared = 0;
    const scores: number[] = [];
    for (const s of students) {
      const c = cells[s.id];
      if (!c) continue;
      if (c.sub === "MISSED_INVALID" && a.maxScore != null) scores.push(0);
      if (!cellHasData(c) || isMissed(c.sub)) continue;
      evaluated += 1;
      if (c.ev === "SHARED") shared += 1;
      if (c.score != null) scores.push(c.score);
    }
    const avg = scores.length ? scores.reduce((x, y) => x + y, 0) / scores.length : null;
    return { evaluated, shared, avg };
  }, [students, cells, a.maxScore]);

  const commentCol = a.criteria.length + (a.maxScore != null ? 1 : 0);

  return (
    <div className="card overflow-hidden" data-gb-root>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 px-4 py-2.5 text-sm">
        <span className="text-slate-600">{t("ev_EVALUATED")}: <b className="tabular-nums text-slate-900">{stats.evaluated}/{students.length}</b></span>
        <span className="text-slate-600">{t("published")}: <b className="tabular-nums text-slate-900">{stats.shared}</b></span>
        {a.maxScore != null && stats.avg != null && (
          <span className="text-slate-600">{t("average")}: <b className="tabular-nums text-slate-900">{stats.avg.toFixed(1)}</b> <span className="text-slate-400">/ {fmtScore(a.maxScore)} · {fmtPct((stats.avg / a.maxScore) * 100)}%</span></span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {stale && <span className="text-xs text-slate-500">{t("refreshing")}</span>}
          <SaveIndicator pending={saver.pending} savedAt={saver.savedAt} canEdit={canEdit} t={t} />
          {canEdit && stats.shared > 0 && <button type="button" className="btn btn-sm" disabled={bulk || saver.pending > 0} onClick={() => void publish(false)}>{t("hideGrades")}</button>}
          {canEdit && <button type="button" className="btn btn-primary btn-sm" disabled={bulk || saver.pending > 0 || stats.evaluated === stats.shared} onClick={() => void publish(true)}>{t("publishGrades")}</button>}
        </span>
      </div>
      <ErrorBanner text={saver.error ?? localError} onClose={() => { saver.clearError(); setLocalError(null); }} t={t} />
      {notice && (
        <div role="status" className="flex items-start gap-2 border-b border-green-200 bg-green-50 px-4 py-2 text-sm text-green-900">
          <span aria-hidden>✓</span><span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="rounded px-1 hover:bg-green-100" aria-label={t("close")}>✕</button>
        </div>
      )}
      <div className={`overflow-x-auto transition-opacity ${stale ? "opacity-60" : ""}`}>
        <table className="tbl ag">
          <thead>
            <tr>
              <th className="w-8 text-right">№</th>
              <th>{t("student")}</th>
              {a.criteria.map((c) => <th key={c.id} className="text-center" title={`${c.code}. ${c.name}`}>{c.code} <span className="font-normal text-slate-400">0–{c.maxLevel}</span></th>)}
              {a.maxScore != null && <th className="text-center">{t("score")} <span className="font-normal text-slate-400">/{fmtScore(a.maxScore)}</span></th>}
              {a.maxScore != null && <th className="text-right">%</th>}
              <th>{t("submissionStatus")}</th>
              <th className="w-full min-w-[14rem]">{t("comment")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {students.map((s, r) => {
              const cell = cells[s.id] ?? empty;
              const missed = isMissed(cell.sub) ? cell.sub : null;
              const missedLabel = missed ? MISSED_LABEL[missed] : null;
              const missedTone = missed === "MISSED_VALID" ? "font-medium text-blue-600" : missed === "MISSED_INVALID" ? "font-medium text-red-600" : "";
              return (
                <tr key={s.id}>
                  <td className="text-right text-xs tabular-nums text-slate-400">{r + 1}</td>
                  <td className="whitespace-nowrap font-medium"><Link href={`/students/${s.id}`} className="hover:underline">{s.name}</Link></td>
                  {a.criteria.map((c, i) => {
                    const v = cell.levels[c.id] ?? null;
                    return (
                      <td key={c.id} className="ag-cell">
                        <GradeInput value={missedLabel ?? (v == null ? "" : String(v))} r={r} c={i} disabled={!canEdit} inputMode="numeric" ariaLabel={`${s.name} — ${c.code}`}
                          className={missed ? missedTone : v != null ? `font-medium ${levelTone(v)}` : ""}
                          onCommit={(raw) => commitGrade(s.id, raw, { criterionId: c.id, max: c.maxLevel })} />
                      </td>
                    );
                  })}
                  {a.maxScore != null && (
                    <td className="ag-cell">
                      <GradeInput value={missedLabel ?? fmtScore(cell.score)} r={r} c={a.criteria.length} disabled={!canEdit} ariaLabel={`${s.name} — ${t("score")}`} className={missedTone}
                        onCommit={(raw) => commitGrade(s.id, raw, { max: a.maxScore! })} />
                    </td>
                  )}
                  {a.maxScore != null && (
                    <td className="text-right tabular-nums text-slate-500">
                      {missed === "MISSED_INVALID" ? "0%" : cell.score != null && !missed ? `${Math.round((cell.score / a.maxScore) * 100)}%` : <span className="text-slate-300">—</span>}
                    </td>
                  )}
                  <td>
                    <select value={cell.sub === "RETURNED" ? "SUBMITTED" : cell.sub} disabled={!canEdit} aria-label={`${s.name} — ${t("submissionStatus")}`}
                      onChange={(e) => { setStatus(s.id, e.target.value as SubStatus); }}
                      className={`input py-1 text-xs ${missed === "MISSED_VALID" ? "border-blue-300 text-blue-800" : missed === "MISSED_INVALID" ? "border-red-300 text-red-800" : ""}`}>
                      {STATUSES.map((st) => <option key={st} value={st}>{t(`sub_${st}`)}</option>)}
                    </select>
                  </td>
                  <td>
                    <CommentInput key={cell.comment} initial={cell.comment} r={r} c={commentCol} disabled={!canEdit} ariaLabel={`${s.name} — ${t("comment")}`} placeholder={t("commentPlaceholder")}
                      onSave={(text) => edit(s.id, { comment: text }, (c) => ({ ...c, comment: text }))} />
                  </td>
                  <td className="whitespace-nowrap text-right">
                    {missed === "MISSED_VALID" ? <Badge tone="blue">EX</Badge>
                      : missed === "MISSED_INVALID" ? <Badge tone="red">0*</Badge>
                      : cellHasData(cell) ? <Badge tone={cell.ev === "SHARED" ? "green" : "amber"}>{cell.ev === "SHARED" ? t("published") : t("notPublished")}</Badge>
                      : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {canEdit && <div className="border-t border-slate-200 px-4 py-2.5 text-xs text-slate-500">{t("gbHint")}</div>}
    </div>
  );
}

/** Комментарий в строке: сохраняется при уходе из поля или по Enter (Enter переводит к следующему ученику). */
function CommentInput({ initial, r, c, disabled, ariaLabel, placeholder, onSave }: { initial: string; r: number; c: number; disabled: boolean; ariaLabel: string; placeholder: string; onSave: (text: string) => void }) {
  const [text, setText] = useState(initial);
  const commit = () => { if (text.trim() !== initial) onSave(text.trim()); };
  return (
    <input value={text} data-r={r} data-c={c} disabled={disabled} maxLength={2000} aria-label={ariaLabel} placeholder={disabled ? "" : placeholder}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const el = e.currentTarget;
          commit();
          focusGridCell(el, r, c, e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey) ? -1 : 1, 0);
        } else if (e.key === "Escape") setText(initial);
      }}
      className="input w-full py-1 placeholder:text-slate-300" />
  );
}
