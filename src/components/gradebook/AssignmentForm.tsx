"use client";
/**
 * Форма задания: создание и редактирование. Ошибки показываются в самой форме, введённые значения сохраняются.
 */
import Link from "next/link";
import { startTransition, useActionState, useState } from "react";
import { saveAssignment, type AssignmentFormState } from "@/app/actions/assignments";
import type { Loc } from "@/lib/i18n-dict";
import { useT } from "./shared";

type Values = NonNullable<AssignmentFormState["values"]>;

export function AssignmentForm({ locale, courseId, assignmentId, initial, periods, criteria, cancelHref, scoreRequired }: {
  locale: Loc;
  courseId: string;
  assignmentId?: string;
  initial: Values;
  periods: { id: string; name: string }[];
  criteria: { id: string; code: string; name: string; maxLevel: number }[];
  cancelHref: string;
  /** предмет без критериев (DP): без макс. балла оценивать нечего */
  scoreRequired: boolean;
}) {
  const t = useT(locale);
  const [state, action, pending] = useActionState<AssignmentFormState, FormData>(saveAssignment, {});
  const [v, setV] = useState<Values>(initial);
  const set = <K extends keyof Values>(k: K, value: Values[K]) => setV((prev) => ({ ...prev, [k]: value }));
  const toggleCriterion = (id: string) => set("criteria", v.criteria.includes(id) ? v.criteria.filter((x) => x !== id) : [...v.criteria, id]);

  // Отправляем значения из состояния формы, а не через <form action>: иначе React после ответа сервера
  // сбрасывает поля к исходным значениям, и при ошибке флажки и списки расходятся с тем, что выбрал учитель.
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData();
    fd.set("courseId", courseId);
    if (assignmentId) fd.set("assignmentId", assignmentId);
    for (const k of ["title", "type", "due", "periodId", "maxScore", "instructions"] as const) fd.set(k, v[k]);
    for (const id of v.criteria) fd.append("criteria", id);
    startTransition(() => action(fd));
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {state.error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          ⚠ {t(state.error)}{state.errorValue != null ? ` ${state.errorValue}` : ""}
        </div>
      )}
      <div>
        <label className="label" htmlFor="af-title">{t("title")}</label>
        <input id="af-title" name="title" required maxLength={200} value={v.title} onChange={(e) => set("title", e.target.value)} className="input w-full" placeholder="Суммативная работа: …" autoFocus={!assignmentId} />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="af-type">{t("type")}</label>
          <select id="af-type" name="type" className="input w-full" value={v.type} onChange={(e) => set("type", e.target.value)}>
            <option value="SUMMATIVE">{t("type_SUMMATIVE")}</option>
            <option value="FORMATIVE">{t("type_FORMATIVE")}</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="af-due">{t("dueDate")}</label>
          <input id="af-due" type="date" name="due" required className="input w-full" value={v.due} onChange={(e) => set("due", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="af-period">{t("period")}</label>
          <select id="af-period" name="periodId" className="input w-full" value={v.periodId} onChange={(e) => set("periodId", e.target.value)}>
            {periods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>
      {criteria.length > 0 && (
        <fieldset>
          <legend className="label">{t("forCriteria")}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {criteria.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                <input type="checkbox" name="criteria" value={c.id} checked={v.criteria.includes(c.id)} onChange={() => toggleCriterion(c.id)} />
                <b>{c.code}</b> {c.name} <span className="ml-auto text-xs text-slate-400">0–{c.maxLevel}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div>
        <label className="label" htmlFor="af-max">{t("maxScore")}</label>
        <input id="af-max" type="number" name="maxScore" min={0.5} step="0.5" required={scoreRequired} className="input w-32" value={v.maxScore} onChange={(e) => set("maxScore", e.target.value)} />
        <p className="mt-1 text-xs text-slate-500">{t("maxScoreHint")}</p>
      </div>
      <div>
        <label className="label" htmlFor="af-instructions">{t("instructions")}</label>
        <textarea id="af-instructions" name="instructions" rows={3} maxLength={5000} className="input w-full" value={v.instructions} onChange={(e) => set("instructions", e.target.value)} />
      </div>
      <div className="flex justify-end gap-2">
        <Link href={cancelHref} className="btn">{t("cancel")}</Link>
        <button className="btn btn-primary" disabled={pending}>{pending ? t("saving") : assignmentId ? t("save") : t("create")}</button>
      </div>
    </form>
  );
}

/** Кнопка отправки формы с подтверждением (для необратимых на вид действий). */
export function ConfirmSubmit({ message, className, children }: { message: string; className?: string; children: React.ReactNode }) {
  return (
    <button className={className} onClick={(e) => { if (!window.confirm(message)) e.preventDefault(); }}>
      {children}
    </button>
  );
}
