import type { z } from 'zod';
import { formValuesEquivalent } from '../../browser/formFill';
import { hasConfirmedPrivacyConsent, isStrictPrivacyTermsLabel } from '../applicationEvidence';
import { type ReviewControlMeta } from '../formReview';
import { writeApplicationField } from '../writeApplicationField';
import { loadDropdownOptions, type FormOutline, type OutlineField } from './outline';
import type { valuesSchema, Run } from './planContext';
import { sectionItems } from './structure';

export function formValuesKey(outline: FormOutline): string {
  return JSON.stringify(
    [...outline.fields.values()].map(field => [
      field.field.key,
      field.value,
      field.valid,
      field.message,
      field.selectionConfirmed,
    ]),
  );
}

export function outlineHasRequiredMarkers(outline: FormOutline): boolean {
  return [...outline.fields.values()].some(field => field.required);
}

export function formatAskLine(field: OutlineField, question: string, optionHint = ''): string {
  const binding = field.field.key ? `（review_key=${JSON.stringify(field.field.key)}）` : '';
  return `${field.label}${binding}：${question}${optionHint}`;
}

export function isSettledVerifiedField(run: Run, field: OutlineField): boolean {
  if (run.resolvedRevealToggles.has(field.field.key)) return true;
  if (['checkbox', 'radio', 'switch'].includes(field.kind)) return false;
  if (run.problems.has(field.id) || run.pendingOptionReplan.has(field.id)) return false;
  if (!field.valid || field.selectionConfirmed === false || !field.value.trim()) return false;
  const entry = run.context.review.entry(field.field);
  if (!entry || entry.status !== 'filled' || !entry.hasExpectation) return false;
  return formValuesEquivalent(field.value, entry.expectedValue) || formValuesEquivalent(field.value, entry.actualValue);
}

export function isNonInteractiveReadOnly(field: OutlineField): boolean {
  return (field.kind === 'text' || field.kind === 'textarea') && field.readOnly && !field.datePicker;
}

export function outlineControlMeta(field: OutlineField, options?: string[]): ReviewControlMeta {
  const controlKind: ReviewControlMeta['controlKind'] = field.datePicker
    ? 'date'
    : field.kind === 'select'
      ? 'select'
      : field.kind === 'combobox'
        ? 'combobox'
        : ['checkbox', 'radio', 'switch'].includes(field.kind)
          ? 'toggle'
          : field.kind === 'textarea'
            ? 'textarea'
            : 'text';
  const resolvedOptions = options?.length ? options : field.options;
  return {
    controlKind,
    ...(field.typable !== undefined ? { typable: field.typable } : {}),
    ...(field.multiple !== undefined ? { multiple: field.multiple } : {}),
    ...(controlKind === 'text' || controlKind === 'textarea' ? { readOnly: field.readOnly } : {}),
    ...(field.requirements?.dateFormats?.[0] ? { dateFormat: field.requirements.dateFormats[0] } : {}),
    ...(resolvedOptions?.length ? { options: [...resolvedOptions] } : {}),
  };
}

export async function ensureFieldOptions(
  run: Run,
  outline: FormOutline,
  field: OutlineField,
): Promise<string[] | undefined> {
  if (field.options?.length) {
    run.loadedOptions.set(field.id, [...field.options]);
    return field.options;
  }
  if (!field.datePicker && (field.kind === 'combobox' || field.kind === 'select') && run.context.browserContext) {
    await loadDropdownOptions(run.context, outline, new Set([field.id])).catch(() => false);
  }
  if (field.options?.length) {
    run.loadedOptions.set(field.id, [...field.options]);
    return field.options;
  }
  return undefined;
}

export async function remember(
  run: Run,
  outline: FormOutline,
  asks: z.infer<typeof valuesSchema>['ask'],
): Promise<void> {
  const hasConsent = hasConfirmedPrivacyConsent(run.context);
  const hasRequiredMarkers = outlineHasRequiredMarkers(outline);
  for (const ask of asks) {
    const field = ask.id ? outline.fields.get(ask.id) : undefined;
    if (
      !field ||
      run.written.has(field.id) ||
      isSettledVerifiedField(run, field) ||
      run.resolvedRevealToggles.has(field.field.key) ||
      run.context.review.isSkipped(field.field)
    )
      continue;
    const isConsentToggle =
      ['checkbox', 'radio', 'switch'].includes(field.kind) &&
      isStrictPrivacyTermsLabel(`${field.label} ${ask.question}`);
    if (isConsentToggle && hasConsent) {
      if (field.value !== 'true') {
        try {
          const page = await run.context.browserContext.getCurrentPage();
          if (typeof page.clickApplicationToggle === 'function') {
            const toggled = await writeApplicationField(run.context, page, {
              field: field.field,
              node: field.node,
              value: 'true',
              method: 'check',
              policy: 'never',
              observedValue: field.value,
            });
            await run.record(run.context, toggled, field.field, 'true', field.required);
            if (toggled.status === 'verified') {
              field.value = 'true';
              run.written.add(field.id);
              continue;
            }
          }
        } catch {
          /* Fall through to question if toggle fails. */
        }
      } else {
        continue;
      }
    }
    if (!isConsentToggle && !field.required && hasRequiredMarkers) {
      if (!isNonInteractiveReadOnly(field)) {
        run.context.review.recordOptionalMissing(field.field, undefined, outlineControlMeta(field));
      }
      continue;
    }
    const hadOptions = Boolean(field.options?.length);
    const options = isConsentToggle ? ['同意'] : await ensureFieldOptions(run, outline, field);
    if (!hadOptions && options?.length && run.addedFieldIds.has(field.id) && !run.replannedOptionIds.has(field.id)) {
      run.replannedOptionIds.add(field.id);
      run.pendingOptionReplan.add(field.id);
    }
    const optionHint = options?.length ? `（可选项：${options.slice(0, 30).join('、')}）` : '';
    run.asks.set(ask.id ?? ask.question, formatAskLine(field, ask.question, optionHint));
    run.context.review.requestInformation(
      field.field,
      `需要用户提供：${ask.question}${optionHint}`,
      field.required,
      options,
      outlineControlMeta(field, options),
    );
  }
}

export function problemsText(run: Run): string {
  return [...run.problems.values()]
    .map(
      p =>
        `${p.id} ${p.label}：试过「${p.value}」→ ${p.reason}${p.actual !== undefined ? `；回读「${p.actual}」` : ''}${p.fieldText ? `；附近文字「${p.fieldText.slice(0, 120)}」` : ''}`,
    )
    .join('\n');
}

function writableCompanionFields(run: Run, outline: FormOutline, sourceId: string): OutlineField[] {
  let scopeFields: OutlineField[] | null = null;
  for (const section of run.sections) {
    const items = sectionItems(outline, section, run.sections);
    if (items?.some(item => item.type === 'field' && item.id === sourceId)) {
      scopeFields = items.filter((item): item is OutlineField => item.type === 'field');
      break;
    }
  }
  const candidates = scopeFields ?? [...outline.fields.values()];
  return candidates.filter(
    field =>
      field.id !== sourceId &&
      !['checkbox', 'radio', 'switch', 'select'].includes(field.kind) &&
      !field.datePicker &&
      !/校区|分校/.test(field.label) &&
      field.valueKnown &&
      !field.value.trim() &&
      !run.written.has(field.id) &&
      !run.problems.has(field.id) &&
      !run.context.review.isSkipped(field.field) &&
      !run.context.review.isAutoDeferred(field.field),
  );
}

/** 必填留空、校验报错、动态新长出的字段，以及选项降级后尚未表达细节的补充项，一并交给修复轮闭环。 */
export function openIssues(run: Run, outline: FormOutline): string {
  const asked = new Set(run.asks.keys());
  const isNewlyRevealed = (field: OutlineField) =>
    run.plannedFieldKeys.size > 0 &&
    !run.plannedFieldKeys.has(field.field.key) &&
    !run.written.has(field.id) &&
    !run.resolvedRevealToggles.has(field.field.key) &&
    field.valueKnown &&
    (['checkbox', 'radio', 'switch'].includes(field.kind) ? field.value === 'false' : !field.value.trim());

  const hasPriorRejectedFeedback = (field: OutlineField) => {
    const entry = run.context.review.entry(field.field);
    return Boolean(
      entry &&
        entry.status === 'failed' &&
        !entry.autoDeferred &&
        !['MISSING_INFORMATION', 'DATE_PRECISION_REQUIRED', 'OPTIONAL_MISSING'].includes(entry.failureCode ?? '') &&
        entry.message,
    );
  };

  const lines = [...outline.fields.values()]
    .filter(
      field =>
        !run.context.review.isSkipped(field.field) &&
        !run.context.review.isAutoDeferred(field.field) &&
        (!asked.has(field.id) || run.pendingOptionReplan.has(field.id)) &&
        !run.problems.has(field.id),
    )
    .filter(
      field =>
        run.pendingOptionReplan.has(field.id) ||
        hasPriorRejectedFeedback(field) ||
        (!field.valid && field.message) ||
        (field.required &&
          field.valueKnown &&
          !field.value.trim() &&
          !['checkbox', 'radio', 'switch'].includes(field.kind)) ||
        isNewlyRevealed(field),
    )
    .map(field => {
      if (run.pendingOptionReplan.has(field.id)) {
        return `${field.id} ${field.label}：已读出真实选项，请结合选项与资料重新判断能否直接填写`;
      }
      if (hasPriorRejectedFeedback(field)) {
        return `${field.id} ${field.label}：${run.context.review.entry(field.field)!.message}`;
      }
      if (
        (!field.valid && field.message) ||
        (field.required && !field.value.trim() && !['checkbox', 'radio', 'switch'].includes(field.kind))
      ) {
        return `${field.id} ${field.label}：${field.value.trim() ? field.message : '必填但仍为空'}`;
      }
      return `${field.id} ${field.label}：上一轮操作后页面新出现的字段，请结合资料与当前上下文判断填写或留空`;
    });

  for (const info of run.unexpressedDetails.values()) {
    const companions = writableCompanionFields(run, outline, info.id);
    if (companions.length > 0) {
      const hint = companions
        .slice(0, 4)
        .map(f => `${f.id} ${f.label}`)
        .join('、');
      lines.push(
        `${info.id} ${info.label}：原计划填「${info.requested}」，因网页选项限制已选「${info.selected}」，具体细节「${info.detail}」尚未表达；请检查同组空白字段（${hint}），语义相符时补入该具体事实，语义不符则留空`,
      );
    }
  }

  return lines.join('\n');
}

export function pruneDisconnectedFields(run: Run, outline: FormOutline): void {
  const url = outline.state?.url;
  if (!url || !outline.fields.size) return;
  const liveKeys = new Set<string>();
  for (const field of outline.fields.values()) {
    liveKeys.add(field.field.key);
    if (field.field.legacyKey) liveKeys.add(field.field.legacyKey);
  }
  for (const probId of [...run.problems.keys()]) {
    if (!outline.fields.has(probId)) run.problems.delete(probId);
  }
  for (const askId of [...run.asks.keys()]) {
    if (/^q\d+$/.test(askId) && !outline.fields.has(askId)) run.asks.delete(askId);
  }
  run.context.review.pruneDisconnected(url, liveKeys);
}
