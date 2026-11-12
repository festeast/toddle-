"use client";
/**
 * Общие части журнала в браузере: поле оценки с клавиатурной навигацией, автосохранение ячеек,
 * индикатор сохранения, выпадающее меню и обновление устаревших данных.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { saveCell } from "@/app/actions/grading";
import { translate, type DictKey, type Loc } from "@/lib/i18n-dict";
import type { Cell, CellPatch, RowTotals, SaveError } from "@/lib/grading/types";

export type T = (k: DictKey) => string;
export const useT = (locale: Loc): T => useMemo(() => (k: DictKey) => translate(locale, k), [locale]);

export const isMissed = (s: string | null | undefined): s is "MISSED_VALID" | "MISSED_INVALID" => s === "MISSED_VALID" || s === "MISSED_INVALID";
export const cellHasData = (c: Cell) => c.score != null || Object.values(c.levels).some((l) => l != null);
/** Ввод оценки означает, что работа сдана: снимается пропуск и статус «не сдано» (то же правило, что на сервере). */
export const markSubmitted = (c: Cell): Cell => (c.sub === "NOT_SUBMITTED" || isMissed(c.sub) ? { ...c, sub: "SUBMITTED", makeupUntil: null } : c);

const ERR_KEY: Record<SaveError, DictKey> = { forbidden: "errForbidden", notFound: "errNotFound", range: "errRange", invalid: "errInvalid" };

// ---------------------------------------------------------------------------
// Свежесть данных. Next.js при переходе «назад» показывает страницу из кэша навигации —
// без оценок, сохранённых после её загрузки. Считаем сохранения в этой вкладке и, если страница
// старше последнего сохранения, запрашиваем данные заново.
// ---------------------------------------------------------------------------
let saveRev = 0;
const revAtVersion = new Map<number, number>();
export const bumpSaveRev = () => { saveRev += 1; };

/** Возвращает true, пока показанные данные устарели и идёт их обновление. */
export function useStaleRefresh(version: number, hasPending: boolean): boolean {
  const router = useRouter();
  if (typeof window !== "undefined" && !revAtVersion.has(version)) {
    if (revAtVersion.size > 200) revAtVersion.clear();
    revAtVersion.set(version, saveRev);
  }
  const [stale, setStale] = useState(() => typeof window !== "undefined" && (revAtVersion.get(version) ?? saveRev) < saveRev);
  const [seen, setSeen] = useState(version);
  if (seen !== version) {
    setSeen(version);
    setStale(false);
  }
  useEffect(() => {
    if (!stale) return;
    router.refresh();
    const giveUp = setTimeout(() => setStale(false), 5000); // нет сети — показываем то, что есть
    return () => clearTimeout(giveUp);
  }, [stale, router]);

  // вкладка была скрыта дольше минуты (оценки могли поменяться в другой вкладке) — обновляем при возврате
  const pendingRef = useRef(hasPending);
  pendingRef.current = hasPending;
  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 60_000 && !pendingRef.current) router.refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [router]);
  return stale;
}

// ---------------------------------------------------------------------------
// Автосохранение ячеек
// ---------------------------------------------------------------------------
type SaverOptions = {
  t: T;
  /** подпись ячейки для сообщения об ошибке: «Иванов Тимур — Контрольная 1» */
  label: (assignmentId: string, studentId: string) => string;
  /** текущее значение ячейки */
  current: (assignmentId: string, studentId: string) => Cell;
  /** записать ячейку в состояние журнала */
  apply: (assignmentId: string, studentId: string, cell: Cell) => void;
  /** записать пересчитанный итог ученика */
  applyTotals?: (studentId: string, totals: RowTotals) => void;
};

/**
 * Сохраняет изменения по одной ячейке. Значение показывается сразу, сервер подтверждает его и возвращает
 * пересчитанный итог ученика. При отказе сервера значение возвращается к прежнему, а учитель видит причину.
 */
export function useCellSaver(options: SaverOptions) {
  const router = useRouter();
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /** id ученика → число сохранений в пути (итоги строки приглушаются, пока идёт пересчёт) */
  const [busy, setBusy] = useState<Record<string, number>>({});
  const seq = useRef(new Map<string, number>());
  const opts = useRef(options);
  opts.current = options;

  const save = useCallback((assignmentId: string, studentId: string, patch: CellPatch, optimistic: Cell) => {
    const o = opts.current;
    const key = `${assignmentId}:${studentId}`;
    const before = o.current(assignmentId, studentId);
    const n = (seq.current.get(key) ?? 0) + 1;
    seq.current.set(key, n);
    o.apply(assignmentId, studentId, optimistic);
    setPending((p) => p + 1);
    setBusy((b) => ({ ...b, [studentId]: (b[studentId] ?? 0) + 1 }));
    setError(null);
    const fail = (reason: string) => {
      const cur = opts.current;
      // более поздний ввод в ту же ячейку важнее: не затираем его откатом
      if (seq.current.get(key) === n) cur.apply(assignmentId, studentId, before);
      setError(`${cur.t("notSavedFor")}: ${cur.label(assignmentId, studentId)}. ${reason}`);
      router.refresh(); // сверяемся с сервером
    };
    void (async () => {
      try {
        const res = await saveCell({ assignmentId, studentId, patch });
        const cur = opts.current;
        if (res.ok) {
          if (seq.current.get(key) === n) cur.apply(assignmentId, studentId, res.cell);
          cur.applyTotals?.(studentId, res.totals);
          bumpSaveRev();
          setSavedAt(Date.now());
        } else {
          fail(`${cur.t(ERR_KEY[res.error])}${res.error === "range" && res.max != null ? ` ${res.max}` : ""}`);
        }
      } catch {
        fail(opts.current.t("errNetwork"));
      } finally {
        setPending((p) => Math.max(0, p - 1));
        setBusy((b) => ({ ...b, [studentId]: Math.max(0, (b[studentId] ?? 1) - 1) }));
      }
    })();
  }, [router]);

  // не дать закрыть вкладку, пока оценки ещё в пути
  useEffect(() => {
    if (pending === 0) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  return { save, pending, error, clearError: useCallback(() => setError(null), []), savedAt, busy };
}

export function SaveIndicator({ pending, savedAt, canEdit, t }: { pending: number; savedAt: number | null; canEdit: boolean; t: T }) {
  if (!canEdit) return null;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs" role="status" aria-live="polite">
      {pending > 0 ? (
        <><span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" aria-hidden /><span className="text-slate-600">{t("saving")}</span></>
      ) : savedAt ? (
        <><span className="text-green-600" aria-hidden>✓</span><span className="text-green-700">{t("allSaved")}</span></>
      ) : (
        <span className="text-slate-400">{t("autosaveOn")}</span>
      )}
    </span>
  );
}

export function ErrorBanner({ text, onClose, t }: { text: string | null; onClose: () => void; t: T }) {
  if (!text) return null;
  return (
    <div role="alert" className="flex items-start gap-2 border-b border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
      <span aria-hidden>⚠</span>
      <span className="flex-1">{text}</span>
      <button type="button" onClick={onClose} className="rounded px-1 text-red-700 hover:bg-red-100" aria-label={t("close")}>✕</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Поле оценки
// ---------------------------------------------------------------------------
/** Перевести фокус на соседнее поле сетки (по атрибутам data-r / data-c), пропуская недоступные. */
export function focusGridCell(from: HTMLElement, r: number, c: number, dr: number, dc: number): boolean {
  const root = from.closest("[data-gb-root]");
  if (!root) return false;
  let nr = r + dr;
  let nc = c + dc;
  for (let i = 0; i < 500; i++) {
    const el = root.querySelector<HTMLInputElement>(`[data-r="${nr}"][data-c="${nc}"]`);
    if (!el) return false;
    if (!el.disabled) {
      el.focus();
      return true;
    }
    nr += dr;
    nc += dc;
  }
  return false;
}

type GradeInputProps = {
  /** значение из журнала в том виде, как оно показывается: «12», «7.5», «EX», «0*» или пустая строка */
  value: string;
  r: number;
  c: number;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  inputMode?: "numeric" | "decimal";
  /** принять ввод; вернуть текст ошибки или null, если значение принято */
  onCommit: (raw: string) => string | null;
  onFocus?: () => void;
};

/**
 * Поле ввода оценки. Черновик хранится в самом поле; в журнал значение уходит по Enter, стрелке или уходу из ячейки.
 * Ведёт себя как ячейка электронной таблицы:
 * - щелчок или переход в ячейку выделяет значение целиком — новый ввод заменяет старый;
 * - Enter / ↓ — вниз, Shift+Enter / ↑ — вверх, ← → — в соседнюю ячейку, Esc — отменить ввод;
 * - повторный щелчок по уже выбранной ячейке или F2 включает правку внутри значения: тогда ← → двигают курсор.
 */
export function GradeInput({ value, r, c, disabled, ariaLabel, className = "", inputMode = "decimal", onCommit, onFocus }: GradeInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = draft ?? value;
  const input = useRef<HTMLInputElement>(null);
  /** правка внутри значения (F2 или повторный щелчок): стрелки влево/вправо двигают курсор, а не переводят в соседнюю ячейку */
  const caretMode = useRef(false);
  /** текущее нажатие мыши выбрало ячейку (а не пришлось по уже выбранной) */
  const pressSelects = useRef(false);
  // после отмены ввода (Esc) выделяем прежнее значение сразу после перерисовки, до следующего нажатия клавиши
  const reselect = useRef(false);
  useLayoutEffect(() => {
    if (!reselect.current) return;
    reselect.current = false;
    input.current?.select();
  });

  const commit = (): boolean => {
    if (draft == null) return true;
    if (draft.trim() === value) {
      setDraft(null);
      setError(null);
      return true;
    }
    const err = onCommit(draft);
    if (err) {
      setError(err);
      return false;
    }
    setDraft(null);
    setError(null);
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      if (commit()) focusGridCell(el, r, c, dr, dc);
    };
    if (e.key === "Enter") move(e.shiftKey ? -1 : 1, 0);
    else if (e.key === "ArrowDown") move(1, 0);
    else if (e.key === "ArrowUp") move(-1, 0);
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      // при правке внутри значения стрелки двигают курсор и переводят в соседнюю ячейку только с края поля
      const atEdge = e.key === "ArrowLeft" ? el.selectionStart === 0 && el.selectionEnd === 0 : el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
      if (!caretMode.current || atEdge) move(0, e.key === "ArrowLeft" ? -1 : 1);
    } else if (e.key === "F2") {
      e.preventDefault();
      caretMode.current = true;
      el.setSelectionRange(el.value.length, el.value.length);
    } else if (e.key === "Escape") {
      e.preventDefault();
      caretMode.current = false;
      if (draft == null && error == null) return el.select();
      reselect.current = true;
      setDraft(null);
      setError(null);
    }
  };

  return (
    <span className="relative block">
      <input
        ref={input}
        type="text"
        inputMode={inputMode}
        autoComplete="off"
        spellCheck={false}
        data-r={r}
        data-c={c}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        value={shown}
        onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
        onMouseDown={(e) => {
          const el = e.currentTarget;
          pressSelects.current = document.activeElement !== el && !el.disabled;
          if (pressSelects.current) {
            // первый щелчок выбирает ячейку целиком (иначе браузер поставил бы курсор в место щелчка)
            e.preventDefault();
            el.focus();
          } else caretMode.current = true; // повторный щелчок — правка внутри значения
        }}
        // Браузер при отпускании кнопки сворачивает выделение в курсор, если щелчок пришёлся по выделенному тексту.
        // Отменяем это для щелчка, выбравшего ячейку, и на всякий случай выделяем значение ещё раз.
        onMouseUp={(e) => { if (pressSelects.current) e.preventDefault(); }}
        onClick={(e) => {
          if (!pressSelects.current) return;
          pressSelects.current = false;
          const el = e.currentTarget;
          if (document.activeElement === el && draft == null) el.select();
        }}
        onFocus={(e) => { caretMode.current = false; e.currentTarget.select(); onFocus?.(); }}
        onBlur={() => { caretMode.current = false; commit(); }}
        onKeyDown={onKeyDown}
        className={`gb-input ${error ? "gb-input-error" : ""} ${className}`}
      />
      {error && <span role="alert" className="gb-input-tip">{error}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Выпадающее меню (рисуется поверх страницы, чтобы его не обрезала прокрутка таблицы)
// ---------------------------------------------------------------------------
export function Menu({ label, buttonClass = "", children }: { label: string; buttonClass?: string; children: (close: () => void) => ReactNode }) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const open = pos != null;
  useEffect(() => {
    if (!open) return;
    const close = () => setPos(null);
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("[data-menu]")) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); btn.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  const toggle = () => {
    if (open) return setPos(null);
    const rect = btn.current!.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
  };
  return (
    <>
      <button ref={btn} type="button" data-menu aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={toggle} className={buttonClass}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="3" r="1.4" fill="currentColor" /><circle cx="8" cy="8" r="1.4" fill="currentColor" /><circle cx="8" cy="13" r="1.4" fill="currentColor" /></svg>
      </button>
      {open && createPortal(
        <div data-menu role="menu" style={{ position: "fixed", top: pos.top, right: pos.right }} className="z-50 min-w-[15rem] rounded-lg border border-slate-200 bg-white py-1 text-sm font-normal text-slate-700 shadow-lg">
          {children(() => setPos(null))}
        </div>,
        document.body,
      )}
    </>
  );
}
export const menuItemClass = "block w-full px-3 py-1.5 text-left hover:bg-slate-50 disabled:opacity-50";
