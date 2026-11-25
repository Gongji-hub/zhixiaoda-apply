import { ExplorationStopped } from '../../controlExploration';
import type { z } from 'zod';
import { formValuesEquivalent, type FormWriteResult } from '../../browser/formFill';
import { URLNotAllowedError } from '../../browser/views';
import { containsSanitizationPlaceholder } from '../../services/guardrails/patterns';
import { Actors, ExecutionState } from '../event/types';
import { ApplicationDialogPending, waitForApplicationDialog } from '../applicationDialog';
import { recheckValidationPeer, writeApplicationDateRange, writeApplicationField } from '../writeApplicationField';
import {
    ensureFieldOptions,
    formatAskLine,
    formValuesKey,
    isNonInteractiveReadOnly,
    isSettledVerifiedField,
    outlineControlMeta,
    outlineHasRequiredMarkers,
} from './fieldIssues';
import { optionResolver } from './optionResolver';
import { waitForApplicationResume, type FormOutline, type OutlineField } from './outline';
import type { valuesSchema, Run } from './planContext';

const DATE_LIKE = /^\s*\d{4}\D+\d{1,2}/;

async function write(
  run: Run,
  field: OutlineField,
  value: string,
  how: 'type' | 'choose' | 'choose_many' | 'date' | null,
  items: string[] | null,
): Promise<FormWriteResult | null> {
  const page = await run.context.browserContext.getCurrentPage();
  const pendingDetails: Array<{ requested: string; selected: string; detail: string }> = [];
  const options = {
    observedValue: field.value,
    signal: run.context.controller.signal,
    resolveOption: optionResolver(
      run.context,
      run.llm,
      field.label,
      () => {
        run.calls++;
      },
      meta => {
        if (meta.selected !== null && meta.unexpressedDetail) {
          pendingDetails.push({
            requested: meta.requested,
            selected: meta.selected,
            detail: meta.unexpressedDetail,
          });
        }
      },
    ),
  };
  run.unexpressedDetails.delete(field.id);
  if (field.kind === 'radio' && value !== 'true') return null;
  const toggle = ['checkbox', 'radio', 'switch'].includes(field.kind);
  const method = toggle
    ? 'check'
    : field.datePicker
      ? 'date'
      : (how ??
        (field.kind === 'combobox' ? 'choose' : field.readOnly ? (DATE_LIKE.test(value) ? 'date' : 'choose') : 'type'));
  const res = await writeApplicationField(run.context, page, {
    field: field.field,
    node: field.node,
    value,
    method,
    policy: 'never',
    items: items ?? undefined,
    observedValue: field.value,
    resolveOption: options.resolveOption,
  });
  if (res?.status === 'verified' && pendingDetails.length > 0) {
    const remainingDetails = pendingDetails.filter(
      d => !res!.actualValue.includes(d.detail) && !formValuesEquivalent(res!.actualValue, d.detail),
    );
    if (remainingDetails.length > 0) {
      run.unexpressedDetails.set(field.id, {
        id: field.id,
        label: field.label,
        requested: remainingDetails.map(d => d.requested).join('、'),
        selected: remainingDetails.map(d => d.selected).join('、'),
        detail: remainingDetails.map(d => d.detail).join('、'),
      });
    }
  }
  return res;
}

export async function applyValues(
  run: Run,
  outline: FormOutline,
  values: z.infer<typeof valuesSchema>['values'],
): Promise<number> {
  let attempted = 0;
  const environment = formValuesKey(outline);
  const hasRequiredMarkers = outlineHasRequiredMarkers(outline);
  const wanted = new Map(values.map(entry => [entry.id, entry.value]));
  const methods = new Map(values.map(entry => [entry.id, entry.how]));
  const lists = new Map(values.map(entry => [entry.id, entry.items]));
  const inferred = new Map(values.map(entry => [entry.id, entry.ai_inferred === true]));
  const rangeResults = new Map<string, FormWriteResult>();
  const validationRejected = new Map<string, { item: OutlineField; value: string; attemptKey: string }>();
  for (const item of outline.items) {
    await waitForApplicationResume(run.context);
    if (item.type !== 'field' || !wanted.has(item.id)) continue;
    const value = wanted.get(item.id)!;
    if (run.resolvedRevealToggles.has(item.field.key)) continue;
    if (run.context.review.isSkipped(item.field) || run.context.review.isAutoDeferred(item.field)) continue;
    if (isSettledVerifiedField(run, item)) {
      const settled = run.context.review.entry(item.field);
      if (
        settled &&
        (formValuesEquivalent(value, settled.expectedValue) ||
          formValuesEquivalent(value, settled.actualValue) ||
          (settled.requestedValue ? formValuesEquivalent(value, settled.requestedValue) : false))
      ) {
        run.written.add(item.id);
        continue;
      }
    }
    const attemptKey = JSON.stringify([
      item.field.key,
      value,
      methods.get(item.id),
      lists.get(item.id),
      item.options,
      environment,
    ]);
    if (run.failedAttempts.has(attemptKey)) {
      run.context.trace?.('整页填写 · 跳过重复失败', 0, item.label);
      continue;
    }
    run.problems.delete(item.id);
    if (inferred.get(item.id)) {
      if (!item.required && hasRequiredMarkers) {
        if (!isNonInteractiveReadOnly(item)) {
          run.context.review.recordOptionalMissing(item.field, undefined, outlineControlMeta(item));
        }
        continue;
      }
      const options = await ensureFieldOptions(run, outline, item);
      const optionHint = options?.length ? `（可选项：${options.slice(0, 30).join('、')}）` : '';
      const question = `请确认${item.label}的实际信息。`;
      run.asks.set(item.id, formatAskLine(item, question, optionHint));
      run.context.review.requestInformation(
        item.field,
        `${question}${optionHint}`,
        item.required,
        options,
        outlineControlMeta(item, options),
      );
      continue;
    }
    if (containsSanitizationPlaceholder(value)) {
      run.problems.set(item.id, { id: item.id, label: item.label, value, reason: '值里含内部脱敏标记，不能写入' });
      continue;
    }
    await run.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, `正在填写 · ${item.label}`);
    await waitForApplicationResume(run.context);
    await waitForApplicationDialog(run.context);
    try {
      attempted++;
      if (item.dateRange?.index === 0 && !rangeResults.has(item.id)) {
        const peer = outline.fields.get(item.dateRange.ids[1]);
        const peerValue = peer && wanted.get(peer.id);
        if (
          peer &&
          peerValue !== undefined &&
          !inferred.get(peer.id) &&
          !containsSanitizationPlaceholder(peerValue) &&
          !run.context.review.isSkipped(peer.field) &&
          !run.context.review.isAutoDeferred(peer.field)
        ) {
          const page = await run.context.browserContext.getCurrentPage();
          const results = await writeApplicationDateRange(run.context, page,
            { node: item.node, field: item.field, value, observedValue: item.value },
            { node: peer.node, value: peerValue, observedValue: peer.value });
          rangeResults.set(item.id, results[0]);
          rangeResults.set(peer.id, results[1]);
        }
      }
      const writeItem = () => write(run, item, value, methods.get(item.id) ?? null, lists.get(item.id) ?? null);
      const rangeResult = rangeResults.get(item.id);
      let result = rangeResult ?? await writeItem();
      if (!rangeResult && result?.status === 'failed' && await waitForApplicationDialog(run.context)) {
        await waitForApplicationResume(run.context);
        result = await writeItem();
      }
      if (!result) continue;
      if (
        result.status === 'failed' &&
        (item.kind === 'combobox' || item.kind === 'select') &&
        Boolean(result.options?.length) &&
        (result.code === 'OPTION_NOT_FOUND' ||
          (result.code === 'WRITE_FAILED' && /无法确定适合.*的候选|没有与.*完全一致的选项/.test(result.message)))
      ) {
        result = {
          ...result,
          code: 'MISSING_INFORMATION',
          message: `「${value}」不在当前字段可选范围内，请确认适用项或选择跳过。`,
        };
      }
      if (
        (result.code === 'MISSING_INFORMATION' || result.code === 'DATE_PRECISION_REQUIRED') &&
        !item.required &&
        hasRequiredMarkers
      ) {
        item.options = result.options;
        run.failedAttempts.add(attemptKey);
        if (!isNonInteractiveReadOnly(item)) {
          run.context.review.recordOptionalMissing(item.field, undefined, outlineControlMeta(item, result.options));
        }
        continue;
      }
      await run.record(run.context, result, item.field, value, item.required);
      const recordedEntry = run.context.review.entry(item.field);
      if (recordedEntry && !recordedEntry.controlKind) {
        Object.assign(recordedEntry, outlineControlMeta(item, result.options));
      }
      if (result.status === 'verified') {
        item.value = result.actualValue;
        item.valid = true;
        item.selectionConfirmed = true;
        run.written.add(item.id);
        run.asks.delete(item.id);
        run.preserved.delete(item.id);
        run.pendingOptionReplan.delete(item.id);
        validationRejected.delete(item.id);
        if (validationRejected.size > 0) {
          const page = await run.context.browserContext.getCurrentPage();
          for (const [prevId, prev] of validationRejected) {
            const actual = await recheckValidationPeer(
              run.context,
              page,
              prev.item.node,
              prev.item.field,
              prev.value,
              prev.item.required,
            );
            if (actual === undefined) continue;
            validationRejected.delete(prevId);
            run.problems.delete(prevId);
            run.failedAttempts.delete(prev.attemptKey);
            run.written.add(prevId);
          }
        }
      } else if (result.code === 'MISSING_INFORMATION' || result.code === 'DATE_PRECISION_REQUIRED') {
        item.options = result.options;
        run.failedAttempts.add(attemptKey);
        const optionHint = result.options?.length ? `（可选项：${result.options.slice(0, 30).join('、')}）` : '';
        run.asks.set(item.id, formatAskLine(item, result.message, optionHint));
      } else if (result.status === 'preserved')
        run.preserved.set(item.id, `${item.label}：现有「${result.actualValue}」，建议「${value}」`);
      else if (result.code === 'READBACK_DIFFERS') {
        // Written and stable; only the wording differs. No replan or retry, one judgement later.
        run.failedAttempts.add(attemptKey);
        run.readbackDiffs.set(item.id, { id: item.id, field: item.field, label: item.label, intended: value,
          displayed: result.actualValue, before: item.value, required: item.required });
      }
      else {
        if (result.options?.length) item.options = result.options;
        run.context.trace?.('整页填写 · 未通过', 0, `${item.label}：${result.code} · ${result.message}`);
        // Neither code means the value was tried; the same write may succeed once the obstruction is gone.
        if (result.code !== 'CLICK_TARGET_OBSCURED' && result.code !== 'PREVIOUS_POPUP_OPEN') {
          run.failedAttempts.add(attemptKey);
        }
        if (result.code === 'VALIDATION_REJECTED') {
          validationRejected.set(item.id, {
            item,
            value,
            attemptKey,
          });
        }
        run.problems.set(item.id, {
          id: item.id,
          label: item.label,
          value,
          reason: `${result.code}: ${result.message}（方式 ${methods.get(item.id) ?? '默认'}）`,
          actual: result.actualValue,
          fieldText: result.fieldText,
        });
      }
    } catch (error) {
      if (error instanceof URLNotAllowedError || error instanceof ApplicationDialogPending || run.context.controller.signal.aborted) throw error;
      run.failedAttempts.add(attemptKey);
      run.problems.set(item.id, {
        id: item.id,
        label: item.label,
        value,
        reason: error instanceof Error ? error.message : String(error),
      });
      await run.record(
        run.context,
        {
          status: 'failed',
          code: error instanceof ExplorationStopped ? error.code : 'WRITE_FAILED',
          message: error instanceof Error ? error.message : String(error),
          actualValue: item.value,
          desiredValue: value,
          attempts: 1,
          adapter: 'readback',
        },
        item.field,
        value,
        item.required,
      );
    }
  }
  for (const id of wanted.keys())
    if (!outline.fields.has(id))
      run.problems.set(id, { id, label: id, value: wanted.get(id)!, reason: '字段已不存在' });
  return attempted;
}
