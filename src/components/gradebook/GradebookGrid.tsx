"use client";
/**
 * Журнал курса за reporting-период: ученики × задания.
 * Оценки вводятся прямо в ячейках и сохраняются автоматически; итоги строки пересчитывает сервер.
 * Порядок колонок как в Toddle: ученик → итог за период → задания → категории с весами.
 */
import Link from "next/link";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { Grade5, Grade7, Level } from "@/components/ui";
import { setAssignmentPublished } from "@/app/actions/grading";
import { fmtDate } from "@/lib/dates";
import { fmtPct, fmtScore, MISSED_LABEL, parseGradeInput, type ParsedInput } from "@/lib/grading/input";
import { EMPTY_CELL, EMPTY_TOTALS, type Cell, type CellPatch, type GbColumn, type GbStudent, type RowTotals, type SubStatus } from "@/lib/grading/types";
import type { Loc } from "@/lib/i18n-dict";
import { bumpSaveRev, cellHasData, ErrorBanner, GradeInput, isMissed, markSubmitted, Menu, menuItemClass, SaveIndicator, useCellSaver, useStaleRefresh, useT, type T } from "./shared";

type Category = { code: string; name: string; weight: number };
type SubjectCriterion = { id: string; code: string; name: string };
type CellMap = Record<string, Record<string, Cell>>;

export type GradebookGridProps = {
  /** метка времени серверных данных: при её смене состояние сетки заменяется свежими данными */
  version: number;
  locale: Loc;
  courseId: string;
  periodAbbr: string;
  canEdit: boolean;
  students: GbStudent[];
  /** задания периода в хронологическом порядке */
  columns: GbColumn[];
  cells: CellMap;
  totals: Record<string, RowTotals>;
  /** критерии предмета (MYP) — итоговые уровни за период */
  subjectCriteria: SubjectCriterion[];
  /** категории процентной схемы с весами */
  categories: Category[];
  /** показывать итоговый процент и категории (есть балльные задания или предмет без критериев) */
  showPercent: boolean;
  initialSort: "asc" | "desc";
};

type SubCol =
  | { kind: "level"; id: string; code: string; name: string; max: number }
  | { kind: "score"; max: number }
  | { kind: "none" };
type Layout = { col: GbColumn; subs: SubCol[]; offset: number };
type TotalCol = { key: string; kind: "pct" | "criterion" | "sum" | "g7" | "g5"; label: string; title?: string };
type TypeFilter = "ALL" | "SUMMATIVE" | "FORMATIVE";

const subColsOf = (col: GbColumn): SubCol[] => {
  const list: SubCol[] = col.criteria.map((c) => ({ kind: "level", id: c.id, code: c.code, name: c.name, max: c.maxLevel }));
  if (col.maxScore != null) list.push({ kind: "score", max: col.maxScore });
  return list.length ? list : [{ kind: "none" }];
};
const emptyCellFor = (col: GbColumn): Cell => ({ ...EMPTY_CELL, levels: Object.fromEntries(col.criteria.map((c) => [c.id, null])) });
const levelTone = (v: number) => (v >= 7 ? "text-emerald-700" : v >= 5 ? "text-green-700" : v >= 3 ? "text-amber-700" : "text-red-700");
const mean = (list: number[]) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const fmt1 = (n: number | null) => (n == null ? "—" : n.toFixed(1));
const pct = (n: number | null) => (n == null ? "—" : `${fmtPct(n)}%`);

export function GradebookGrid(props: GradebookGridProps) {
  const { locale, courseId, canEdit, students, columns, subjectCriteria, categories, showPercent, periodAbbr } = props;
  const t = useT(locale);

  // ---- состояние: ячейки и итоги; при новых серверных данных заменяются целиком ----
  const [version, setVersion] = useState(props.version);
  const [cells, setCells] = useState<CellMap>(props.cells);
  const [totals, setTotals] = useState(props.totals);
  if (version !== props.version) {
    setVersion(props.version);
    setCells(props.cells);
    setTotals(props.totals);
  }
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const colById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const studentById = useMemo(() => new Map(students.map((s) => [s.id, s])), [students]);

  const saver = useCellSaver({
    t,
    label: (aid, sid) => `${studentById.get(sid)?.name ?? ""} — ${colById.get(aid)?.title ?? ""}`,
    current: (aid, sid) => cellsRef.current[sid]?.[aid] ?? (colById.get(aid) ? emptyCellFor(colById.get(aid)!) : EMPTY_CELL),
    apply: (aid, sid, cell) => setCells((prev) => ({ ...prev, [sid]: { ...prev[sid], [aid]: cell } })),
    applyTotals: (sid, tot) => setTotals((prev) => ({ ...prev, [sid]: tot })),
  });
  const stale = useStaleRefresh(props.version, saver.pending > 0);

  // ---- вид: поиск, фильтр по типу, порядок колонок ----
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("ALL");
  const [sort, setSort] = useState(props.initialSort);
  const [notice, setNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [bulk, setBulk] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [active, setActive] = useState<{ studentId: string; assignmentId: string } | null>(null);
  const activeRef = useRef(active);
  const panelOpenRef = useRef(panelOpen);
  panelOpenRef.current = panelOpen;

  const toggleSort = () => {
    const next = sort === "desc" ? "asc" : "desc";
    setSort(next);
    document.cookie = `gb_sort=${next}; path=/; max-age=31536000; samesite=lax`;
  };

  const counts = useMemo(() => ({ SUMMATIVE: columns.filter((c) => c.type === "SUMMATIVE").length, FORMATIVE: columns.filter((c) => c.type === "FORMATIVE").length }), [columns]);
  const layout: Layout[] = useMemo(() => {
    const list = columns.filter((c) => typeFilter === "ALL" || c.type === typeFilter);
    const ordered = sort === "desc" ? [...list].reverse() : list;
    let offset = 0;
    return ordered.map((col) => {
      const subs = subColsOf(col);
      const item = { col, subs, offset };
      offset += subs.length;
      return item;
    });
  }, [columns, typeFilter, sort]);

  const visibleStudents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? students.filter((s) => s.name.toLowerCase().includes(q)) : students;
  }, [students, query]);

  const totalCols: TotalCol[] = useMemo(() => {
    const list: TotalCol[] = [];
    if (showPercent) list.push({ key: "pct", kind: "pct", label: "%", title: t("overallPct") });
    for (const c of subjectCriteria) list.push({ key: c.id, kind: "criterion", label: c.code, title: c.name });
    if (subjectCriteria.length) list.push({ key: "sum", kind: "sum", label: t("sum") });
    list.push({ key: "g7", kind: "g7", label: t("grade7") }, { key: "g5", kind: "g5", label: t("grade5") });
    return list;
  }, [showPercent, subjectCriteria, t]);
  const shownCategories = showPercent ? categories : [];

  // ---- изменение ячейки ----
  const save = saver.save;
  const onEdit = useCallback((studentId: string, col: GbColumn, sub: SubCol, parsed: ParsedInput) => {
    if (sub.kind === "none" || parsed.kind === "error") return;
    const cur = cellsRef.current[studentId]?.[col.id] ?? emptyCellFor(col);
    let patch: CellPatch;
    let next: Cell;
    if (parsed.kind === "missed") {
      patch = { sub: parsed.status };
      next = { ...emptyCellFor(col), sub: parsed.status, comment: cur.comment };
    } else if (parsed.kind === "clear" && isMissed(cur.sub)) {
      patch = { sub: "NOT_SUBMITTED" };
      next = { ...cur, sub: "NOT_SUBMITTED", makeupUntil: null };
    } else {
      const value = parsed.kind === "value" ? parsed.value : null;
      const base: Cell = value != null ? markSubmitted(cur) : cur;
      if (sub.kind === "level") {
        patch = { levels: { [sub.id]: value } };
        next = { ...base, levels: { ...base.levels, [sub.id]: value } };
      } else {
        patch = { score: value };
        next = { ...base, score: value };
      }
    }
    next.ev = cellHasData(next) ? (cur.ev === "SHARED" ? "SHARED" : "EVALUATED") : "NOT_EVALUATED";
    save(col.id, studentId, patch, next);
  }, [save]);

  const onFocusCell = useCallback((studentId: string, assignmentId: string) => {
    activeRef.current = { studentId, assignmentId };
    if (panelOpenRef.current) setActive(activeRef.current);
  }, []);
  const openPanel = useCallback((studentId: string, assignmentId: string) => {
    activeRef.current = { studentId, assignmentId };
    setActive(activeRef.current);
    setPanelOpen(true);
  }, []);
  const togglePanel = () => {
    if (panelOpen) return setPanelOpen(false);
    setActive(activeRef.current);
    setPanelOpen(true);
  };

  // ---- публикация оценок задания ----
  const publish = async (col: GbColumn, on: boolean) => {
    setBulk(col.id);
    setNotice(null);
    setLocalError(null);
    try {
      const res = await setAssignmentPublished(col.id, on);
      if (!res.ok) return setLocalError(`${col.title}: ${t(res.error === "forbidden" ? "errForbidden" : "errInvalid")}`);
      setCells((prev) => {
        const out: CellMap = {};
        for (const [sid, row] of Object.entries(prev)) {
          const cell = row[col.id];
          const flipped = cell && (on ? cell.ev === "EVALUATED" : cell.ev === "SHARED");
          out[sid] = flipped ? { ...row, [col.id]: { ...cell, ev: on ? "SHARED" : "EVALUATED" } } : row;
        }
        return out;
      });
      bumpSaveRev();
      setNotice(`${col.title}: ${t(on ? "gradesPublished" : "gradesHidden").toLowerCase()} (${res.count})`);
    } catch {
      setLocalError(`${col.title}: ${t("errNetwork")}`);
    } finally {
      setBulk(null);
    }
  };

  // ---- сводка по колонкам: сколько оценено и опубликовано, среднее по классу ----
  const colStats = useMemo(() => {
    const out = new Map<string, { evaluated: number; shared: number; avg: (number | null)[] }>();
    for (const { col, subs } of layout) {
      let evaluated = 0;
      let shared = 0;
      const values: number[][] = subs.map(() => []);
      for (const s of students) {
        const cell = cells[s.id]?.[col.id];
        if (!cell) continue;
        if (cell.sub === "MISSED_VALID") continue;
        const zero = cell.sub === "MISSED_INVALID";
        if (cellHasData(cell)) {
          evaluated += 1;
          if (cell.ev === "SHARED") shared += 1;
        }
        subs.forEach((sub, i) => {
          if (sub.kind === "none") return;
          const v = zero ? 0 : sub.kind === "level" ? cell.levels[sub.id] : cell.score;
          if (v != null) values[i].push(v);
        });
      }
      out.set(col.id, { evaluated, shared, avg: values.map(mean) });
    }
    return out;
  }, [layout, students, cells]);

  // точка «не опубликовано» нужна только там, где часть оценок задания уже опубликована (иначе всё сказано в заголовке)
  const mixedKey = layout.filter(({ col }) => { const st = colStats.get(col.id)!; return st.shared > 0 && st.shared < st.evaluated; }).map(({ col }) => col.id).join(",");
  const mixedCols = useMemo(() => new Set(mixedKey ? mixedKey.split(",") : []), [mixedKey]);

  const totalsAvg = useMemo(() => {
    const rows = students.map((s) => totals[s.id] ?? EMPTY_TOTALS);
    const pick = (f: (r: RowTotals) => number | null | undefined) => mean(rows.map(f).filter((v): v is number => v != null));
    return {
      pct: pick((r) => r.overallPct), sum: pick((r) => r.criteriaSum), g7: pick((r) => r.grade7), g5: pick((r) => r.grade5),
      criterion: (id: string) => pick((r) => r.criteria[id]),
      category: (code: string) => pick((r) => r.categoryPct[code]),
    };
  }, [students, totals]);

  const dist = useMemo(() => [1, 2, 3, 4, 5, 6, 7].map((g) => students.filter((s) => totals[s.id]?.grade7 === g).length), [students, totals]);
  const maxDist = Math.max(1, ...dist);

  if (columns.length === 0) {
    return (
      <div className="card px-6 py-12 text-center">
        <div className="text-base font-medium text-slate-700">{t("noAssignmentsInPeriod")}</div>
        <div className="mx-auto mt-1 max-w-md text-sm text-slate-500">{t("noAssignmentsHint")}</div>
        {canEdit && <Link className="btn btn-primary mt-4" href={`/courses/${courseId}/new?period=${periodAbbr}`}>+ {t("newAssignment")}</Link>}
      </div>
    );
  }

  const activeCol = active ? colById.get(active.assignmentId) : undefined;
  const activeStudent = active ? studentById.get(active.studentId) : undefined;

  return (
    <>
      <div className="gb-card" data-gb-root>
          <div className="gb-fit flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2">
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchStudent")} aria-label={t("searchStudent")} className="input w-44 py-1" />
            {counts.SUMMATIVE > 0 && counts.FORMATIVE > 0 && (
              <div className="gb-seg" role="group" aria-label={t("type")}>
                {(["ALL", "SUMMATIVE", "FORMATIVE"] as const).map((f) => (
                  <button key={f} type="button" aria-pressed={typeFilter === f} onClick={() => setTypeFilter(f)} className={typeFilter === f ? "gb-seg-on" : ""}>
                    {f === "ALL" ? t("all") : t(`type_${f}`)} <span className="opacity-60">{f === "ALL" ? columns.length : counts[f]}</span>
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="btn btn-sm" onClick={toggleSort} title={t("dueDate")}>
              <span aria-hidden>⇅</span> {sort === "desc" ? t("sortNewestFirst") : t("sortOldestFirst")}
            </button>
            <button type="button" className={`btn btn-sm ${panelOpen ? "border-brand-500 bg-brand-50 text-brand-700" : ""}`} aria-pressed={panelOpen} onClick={togglePanel}>
              {t("cellDetails")}
            </button>
            <span className="ml-auto flex items-center gap-3">
              {stale && <span className="text-xs text-slate-500">{t("refreshing")}</span>}
              <SaveIndicator pending={saver.pending} savedAt={saver.savedAt} canEdit={canEdit} t={t} />
            </span>
          </div>
          <div className="gb-fit"><ErrorBanner text={saver.error ?? localError} onClose={() => { saver.clearError(); setLocalError(null); }} t={t} /></div>
          {notice && (
            <div role="status" className="gb-fit flex items-start gap-2 border-b border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
              <span aria-hidden>✓</span><span className="flex-1">{notice}</span>
              <button type="button" onClick={() => setNotice(null)} className="rounded px-1 hover:bg-green-100" aria-label={t("close")}>✕</button>
            </div>
          )}

          <div className={`gb-scroll ${stale ? "opacity-60" : ""}`}>
            <table className="gb">
              <thead>
                <tr>
                  <th rowSpan={2} className="gb-sticky gb-student-head">
                    {t("student")} <span className="font-normal text-slate-400">· {visibleStudents.length}</span>
                  </th>
                  <th colSpan={totalCols.length} className="gb-total-head text-center">{t("periodTotal")} · {periodAbbr}</th>
                  {layout.map(({ col, subs }) => {
                    const st = colStats.get(col.id)!;
                    return (
                      <th key={col.id} colSpan={subs.length} className={`gb-assign ${col.type === "SUMMATIVE" ? "gb-sa" : "gb-fa"}`}>
                        <div className="gb-fit flex items-start gap-1">
                          <div className="min-w-0 flex-1">
                            <div className="text-[11px] font-normal text-slate-500">{col.due}</div>
                            <Link href={`/assignments/${col.id}`} title={col.title} className="line-clamp-2 text-[13px] font-semibold leading-snug text-slate-800 [overflow-wrap:anywhere] hover:text-brand-700 hover:underline">{col.title}</Link>
                          </div>
                          <Menu label={`${t("actions")}: ${col.title}`} buttonClass="gb-menu-btn">
                            {(close) => (
                              <>
                                <Link href={`/assignments/${col.id}`} role="menuitem" className={menuItemClass}>{t("openAssignment")}</Link>
                                {canEdit && st.evaluated > st.shared && (
                                  <button type="button" role="menuitem" className={menuItemClass} disabled={bulk === col.id} onClick={() => { close(); void publish(col, true); }}>
                                    {t("publishShort")} <span className="text-slate-400">({st.evaluated - st.shared})</span>
                                  </button>
                                )}
                                {canEdit && st.shared > 0 && (
                                  <button type="button" role="menuitem" className={menuItemClass} disabled={bulk === col.id} onClick={() => { close(); void publish(col, false); }}>{t("hideGrades")}</button>
                                )}
                                {canEdit && <Link href={`/assignments/${col.id}/edit`} role="menuitem" className={menuItemClass}>{t("edit")}</Link>}
                              </>
                            )}
                          </Menu>
                        </div>
                        <div className="gb-fit mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] font-normal">
                          <span className={`gb-chip ${col.type === "SUMMATIVE" ? "bg-violet-100 text-violet-800" : "bg-sky-100 text-sky-800"}`} title={t(`type_${col.type}`)}>{col.type === "SUMMATIVE" ? "SA" : "FA"}</span>
                          {st.evaluated === 0 ? <span className="text-slate-400">{t("noGrades")}</span>
                            : st.shared === st.evaluated ? <span className="text-green-700">✓ {t("published")}</span>
                            : st.shared === 0 ? <span className="text-amber-700">{t("notPublished")}</span>
                            : <span className="text-amber-700">{t("published")} {st.shared}/{st.evaluated}</span>}
                        </div>
                      </th>
                    );
                  })}
                  {shownCategories.map((c) => (
                    <th key={c.code} rowSpan={2} className="gb-cat-head text-center">
                      <div className="text-[13px] font-semibold text-slate-700">{c.name}</div>
                      <div className="font-normal text-slate-500">{t("weight")} {c.weight}%</div>
                    </th>
                  ))}
                  <th rowSpan={2} className="gb-filler" aria-hidden />
                </tr>
                <tr>
                  {totalCols.map((tc) => <th key={tc.key} className="gb-total-head gb-sub text-center" title={tc.title}>{tc.label}</th>)}
                  {layout.map(({ col, subs }) => subs.map((sub, i) => (
                    <th key={`${col.id}:${i}`} className={`gb-sub text-center ${i === subs.length - 1 ? "gb-col-end" : ""}`} title={sub.kind === "level" ? `${sub.code}. ${sub.name} (0–${sub.max})` : undefined}>
                      {sub.kind === "level" ? sub.code : sub.kind === "score" ? `/${fmtScore(sub.max)}` : "—"}
                    </th>
                  )))}
                </tr>
              </thead>
              <tbody>
                {visibleStudents.map((s, r) => (
                  <Row key={s.id} r={r} student={s} layout={layout} cells={cells[s.id]} totals={totals[s.id] ?? EMPTY_TOTALS} busy={(saver.busy[s.id] ?? 0) > 0}
                    canEdit={canEdit} t={t} courseId={courseId} totalCols={totalCols} categories={shownCategories} mixedCols={mixedCols} onEdit={onEdit} onFocusCell={onFocusCell} onOpenPanel={openPanel} />
                ))}
                {visibleStudents.length === 0 && (
                  <tr><td colSpan={2 + totalCols.length + layout.reduce((n, l) => n + l.subs.length, 0) + shownCategories.length} className="py-6 text-center text-slate-500">{t("nothingFound")}</td></tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td className="gb-sticky gb-student text-left text-xs font-medium text-slate-600">{t("classAverage")}</td>
                  {totalCols.map((tc) => (
                    <td key={tc.key} className="gb-total tabular-nums text-slate-600">
                      {tc.kind === "pct" ? pct(totalsAvg.pct) : tc.kind === "criterion" ? fmt1(totalsAvg.criterion(tc.key)) : tc.kind === "sum" ? fmt1(totalsAvg.sum) : tc.kind === "g7" ? fmt1(totalsAvg.g7) : fmt1(totalsAvg.g5)}
                    </td>
                  ))}
                  {layout.map(({ col, subs }) => subs.map((_, i) => (
                    <td key={`${col.id}:${i}`} className={`tabular-nums text-slate-600 ${i === subs.length - 1 ? "gb-col-end" : ""}`}>{fmt1(colStats.get(col.id)!.avg[i])}</td>
                  )))}
                  {shownCategories.map((c) => <td key={c.code} className="gb-cat tabular-nums text-slate-600">{pct(totalsAvg.category(c.code))}</td>)}
                  <td className="gb-filler" aria-hidden />
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="gb-fit space-y-1.5 border-t border-slate-200 px-3 py-2.5 text-xs text-slate-500">
            {canEdit && <div>{t("gbHint")}</div>}
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span><span className="gb-chip bg-violet-100 text-violet-800">SA</span> {t("type_SUMMATIVE")}</span>
              <span><span className="gb-chip bg-sky-100 text-sky-800">FA</span> {t("type_FORMATIVE")}</span>
              <span><span className="font-medium text-blue-600">EX</span> — {t("sub_MISSED_VALID")}</span>
              <span><span className="font-medium text-red-600">0*</span> — {t("sub_MISSED_INVALID")}</span>
              <span><span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-400 align-middle" /> {t("ev_EVALUATED")}, {t("notPublished").toLowerCase()}</span>
              <span><span className="mr-1 inline-block h-0 w-0 border-l-[6px] border-t-[6px] border-l-transparent border-t-slate-300 align-middle" /> {t("comment")}</span>
              <span><span className="rounded ring-2 ring-violet-400">&nbsp;&nbsp;&nbsp;</span> {t("overridden")}</span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {shownCategories.length > 0 && <span>{t("weightsLegend")}: {shownCategories.map((c) => `${c.name} ${c.weight}%`).join(" + ")}</span>}
              {subjectCriteria.length > 0 && <span>{t("criteriaLegend")}; {t("formativeNotInFinal")}</span>}
            </div>
          </div>
      </div>

      <section className="card gb-fit mt-6">
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-700">{t("distribution")} · {periodAbbr}</h2>
          <span className="text-xs text-slate-500">{t("average")}: <b className="tabular-nums text-slate-700">{fmt1(totalsAvg.g7)}</b></span>
        </div>
        <div className="flex h-28 items-end gap-3 p-4">
          {dist.map((n, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1">
              <div className="text-xs tabular-nums text-slate-500">{n}</div>
              <div className="w-full rounded-t bg-brand-500" style={{ height: `${(n / maxDist) * 56}px`, minHeight: n ? 2 : 0 }} />
              <div className="text-xs font-medium">{i + 1}</div>
            </div>
          ))}
        </div>
      </section>

      {panelOpen && (
        <CellPanel
          key={active ? `${active.assignmentId}:${active.studentId}` : "none"}
          t={t} locale={locale} canEdit={canEdit}
          student={activeStudent} col={activeCol}
          cell={active && activeCol ? cells[active.studentId]?.[active.assignmentId] ?? emptyCellFor(activeCol) : null}
          onClose={() => setPanelOpen(false)}
          onStatus={(status) => {
            if (!active || !activeCol) return;
            const cur = cellsRef.current[active.studentId]?.[active.assignmentId] ?? emptyCellFor(activeCol);
            const next: Cell = isMissed(status)
              ? { ...emptyCellFor(activeCol), sub: status, comment: cur.comment, makeupUntil: status === "MISSED_VALID" ? new Date(Date.now() + 7 * 86400000).toISOString() : null }
              : { ...cur, sub: status, makeupUntil: null };
            save(active.assignmentId, active.studentId, { sub: status }, next);
          }}
          onComment={(comment) => {
            if (!active || !activeCol) return;
            const cur = cellsRef.current[active.studentId]?.[active.assignmentId] ?? emptyCellFor(activeCol);
            save(active.assignmentId, active.studentId, { comment }, { ...cur, comment });
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Строка ученика
// ---------------------------------------------------------------------------
type RowProps = {
  r: number;
  student: GbStudent;
  layout: Layout[];
  cells: Record<string, Cell> | undefined;
  totals: RowTotals;
  busy: boolean;
  canEdit: boolean;
  t: T;
  courseId: string;
  totalCols: TotalCol[];
  categories: Category[];
  /** задания, у которых опубликована только часть оценок */
  mixedCols: Set<string>;
  onEdit: (studentId: string, col: GbColumn, sub: SubCol, parsed: ParsedInput) => void;
  onFocusCell: (studentId: string, assignmentId: string) => void;
  onOpenPanel: (studentId: string, assignmentId: string) => void;
};

const Row = memo(function Row({ r, student, layout, cells, totals, busy, canEdit, t, courseId, totalCols, categories, mixedCols, onEdit, onFocusCell, onOpenPanel }: RowProps) {
  const dim = busy ? "opacity-40" : "";
  return (
    <tr>
      <td className="gb-sticky gb-student">
        <span className="gb-num mr-2 inline-block w-5 text-right text-xs tabular-nums text-slate-400">{r + 1}</span>
        <Link href={`/students/${student.id}`} className="font-medium hover:underline">{student.name}</Link>
      </td>
      {totalCols.map((tc) => (
        <td key={tc.key} className="gb-total">
          <span className={`inline-flex items-center justify-center gap-1 transition-opacity ${dim}`}>
            {tc.kind === "pct" ? <span className="tabular-nums">{totals.overallPct == null ? <span className="text-slate-300">—</span> : `${fmtPct(totals.overallPct)}%`}</span>
              : tc.kind === "criterion" ? <Level value={totals.criteria[tc.key]} />
              : tc.kind === "sum" ? (
                <span className="tabular-nums">
                  {totals.criteriaSum ?? <span className="text-slate-300">—</span>}
                  {totals.criteriaSum != null && totals.criteriaCount != null && totals.criteriaCount > 0 && totals.criteriaCount < totalCols.filter((x) => x.kind === "criterion").length && <span className="text-xs text-slate-400">/{totals.criteriaCount * 8}</span>}
                </span>
              )
              : tc.kind === "g7" ? (
                totals.pgId && totals.grade7 != null ? (
                  <Link href={`/courses/${courseId}/grades/${totals.pgId}`} title={totals.overridden ? `${t("overridden")} · ${t("calculated")}: ${totals.calc7 ?? "—"}` : t("overrideHint")} className="inline-flex items-center gap-1">
                    <Grade7 value={totals.grade7} overridden={totals.overridden} />
                    {totals.published && <span className="text-[10px] text-green-600" title={t("published")}>●</span>}
                  </Link>
                ) : <span className="text-slate-300">—</span>
              )
              : <Grade5 value={totals.grade5} />}
          </span>
        </td>
      ))}
      {layout.map(({ col, subs, offset }) => {
        const cell = cells?.[col.id];
        const missed = isMissed(cell?.sub) ? cell!.sub : null;
        const draft = !!cell && cell.ev !== "SHARED" && cellHasData(cell);
        const muted = col.type === "FORMATIVE" && !col.countsForCriteria && col.maxScore == null;
        return subs.map((sub, i) => {
          const end = i === subs.length - 1 ? "gb-col-end" : "";
          if (sub.kind === "none") return <td key={`${col.id}:${i}`} className={`text-slate-300 ${end}`} title={t("noScale")}>—</td>;
          const value = sub.kind === "level" ? cell?.levels[sub.id] ?? null : cell?.score ?? null;
          const shown = missed ? MISSED_LABEL[missed as keyof typeof MISSED_LABEL] : sub.kind === "level" ? (value == null ? "" : String(value)) : fmtScore(value);
          const tone = missed === "MISSED_VALID" ? "font-medium text-blue-600" : missed === "MISSED_INVALID" ? "font-medium text-red-600"
            : sub.kind === "level" && value != null ? `font-medium ${levelTone(value)}` : "";
          const label = `${student.name} — ${col.title}${sub.kind === "level" ? ` — ${sub.code}` : ""}`;
          return (
            <td key={`${col.id}:${i}`} className={`gb-cell ${muted ? "gb-muted" : ""} ${end}`} onDoubleClick={() => onOpenPanel(student.id, col.id)}
              title={cell?.comment ? cell.comment : draft && i === 0 ? `${t("ev_EVALUATED")}, ${t("notPublished").toLowerCase()}` : undefined}>
              {i === 0 && draft && mixedCols.has(col.id) && <span className="gb-dot-draft" aria-hidden />}
              {i === subs.length - 1 && cell?.comment && <span className="gb-note" aria-hidden />}
              {canEdit ? (
                <GradeInput
                  value={shown} r={r} c={offset + i} ariaLabel={label} className={tone}
                  inputMode={sub.kind === "level" ? "numeric" : "decimal"}
                  onFocus={() => onFocusCell(student.id, col.id)}
                  onCommit={(raw) => {
                    const parsed = parseGradeInput(raw, sub.max, sub.kind === "level");
                    if (parsed.kind === "error") return parsed.code === "range" ? `${t("errRange")} ${fmtScore(sub.max)}` : parsed.code === "integer" ? t("errInteger") : t("errFormat");
                    onEdit(student.id, col, sub, parsed);
                    return null;
                  }}
                />
              ) : (
                // только просмотр (период заблокирован или нет права оценивать): ячейку можно выбрать, чтобы увидеть статус и комментарий
                <button type="button" className={`gb-input gb-readonly ${tone}`} aria-label={`${label}: ${shown || "—"}`} onFocus={() => onFocusCell(student.id, col.id)}>{shown || "\u00a0"}</button>
              )}
            </td>
          );
        });
      })}
      {categories.map((c) => (
        <td key={c.code} className="gb-cat">
          <span className={`tabular-nums transition-opacity ${dim}`}>{totals.categoryPct[c.code] == null ? <span className="text-slate-300">—</span> : `${fmtPct(totals.categoryPct[c.code])}%`}</span>
        </td>
      ))}
      <td className="gb-filler" aria-hidden />
    </tr>
  );
});

// ---------------------------------------------------------------------------
// Панель ячейки: статус сдачи и комментарий
// ---------------------------------------------------------------------------
const PANEL_STATUSES: SubStatus[] = ["SUBMITTED", "LATE", "NOT_SUBMITTED", "MISSED_VALID", "MISSED_INVALID"];

function CellPanel({ t, locale, canEdit, student, col, cell, onClose, onStatus, onComment }: {
  t: T; locale: Loc; canEdit: boolean; student?: GbStudent; col?: GbColumn; cell: Cell | null;
  onClose: () => void; onStatus: (s: SubStatus) => void; onComment: (text: string) => void;
}) {
  const [comment, setComment] = useState(cell?.comment ?? "");
  const saveComment = () => { if (cell && comment.trim() !== cell.comment) onComment(comment.trim()); };
  return (
    <aside className="gb-panel" aria-label={t("cellDetails")}>
      <div className="flex items-start gap-2 border-b border-slate-100 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{student?.name ?? t("cellDetails")}</div>
          {col && <div className="truncate text-xs text-slate-500">{col.title}</div>}
        </div>
        <button type="button" onClick={onClose} className="rounded px-1.5 text-slate-500 hover:bg-slate-100" aria-label={t("close")}>✕</button>
      </div>
      {!cell || !col || !student ? (
        <div className="px-3 py-4 text-sm text-slate-500">{t("cellDetailsHint")}</div>
      ) : (
        <div className="space-y-3 px-3 py-3">
          <div>
            <div className="label">{t("submissionStatus")}</div>
            <div className="flex flex-wrap gap-1">
              {PANEL_STATUSES.map((st) => {
                const on = cell.sub === st;
                return (
                  <button key={st} type="button" disabled={!canEdit} aria-pressed={on}
                    onClick={() => {
                      if (on) return;
                      if (isMissed(st) && cellHasData(cell) && !window.confirm(t("confirmMissed"))) return;
                      onStatus(st);
                    }}
                    className={`rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-60 ${on ? (st === "MISSED_INVALID" ? "border-red-500 bg-red-50 text-red-800" : st === "MISSED_VALID" ? "border-blue-500 bg-blue-50 text-blue-800" : "border-brand-500 bg-brand-50 text-brand-700") : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                    {t(`sub_${st}`)}
                  </button>
                );
              })}
            </div>
            {cell.sub === "MISSED_VALID" && cell.makeupUntil && <div className="mt-1.5 text-xs text-blue-700">{t("makeupUntil")} {fmtDate(new Date(cell.makeupUntil), locale, { day: "numeric", month: "long" })}</div>}
          </div>
          <div>
            <label className="label" htmlFor="gb-panel-comment">{t("comment")}</label>
            <textarea id="gb-panel-comment" rows={3} maxLength={2000} disabled={!canEdit} value={comment} onChange={(e) => setComment(e.target.value)} onBlur={saveComment}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveComment(); } }}
              placeholder={t("commentPlaceholder")} className="input w-full resize-y" />
          </div>
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className={cell.ev === "SHARED" ? "text-green-700" : "text-slate-500"}>{cellHasData(cell) ? (cell.ev === "SHARED" ? `✓ ${t("published")}` : `${t("ev_EVALUATED")}, ${t("notPublished").toLowerCase()}`) : t("ev_NOT_EVALUATED")}</span>
            <Link href={`/assignments/${col.id}`} className="link">{t("openAssignment")} →</Link>
          </div>
        </div>
      )}
    </aside>
  );
}
