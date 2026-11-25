import { exploreUnknownControl } from './unknownControlExploration';
import type { DOMElementNode } from '../browser/dom/views';
import type { FormControlState } from '../browser/formControls';
import { hasCommittedControlValue } from '../browser/controlState';
import { formValuesEquivalent, type FormWriteResult } from '../browser/formFill';
import type Page from '../browser/page';
import type { ApplicationControlOptions } from '../browser/page';
import { isSanitizationPlaceholder } from '../services/guardrails/patterns';
import { URLNotAllowedError } from '../browser/views';
import { formFieldReference, type FormFieldReference, type ReviewControlMeta } from './formReview';
import type { AgentContext } from './types';
import { ControlExploration, ExplorationStopped, explorationModel } from '../controlExploration';
import { Actors, ExecutionState } from './event/types';
import { waitForApplicationPopup } from './applicationDialog';

type WriteMethod = 'type' | 'choose' | 'choose_many' | 'date' | 'check';
interface FieldWrite {
  field: FormFieldReference;
  node: DOMElementNode;
  value: string;
  policy: 'never' | 'approved_grant' | 'direct_user_input';
  method?: WriteMethod;
  items?: string[];
  observedValue?: string;
  resolveOption?: ApplicationControlOptions['resolveOption'];
  useVision?: boolean;
  live?: FormControlState;
}

export function isVerifiedWrite(result: FormWriteResult, expected: string) {
  return (
    result.status === 'verified' ||
    (result.status === 'preserved' && formValuesEquivalent(result.actualValue, result.desiredValue ?? expected))
  );
}

/**
 * The previous field's popup could not be closed automatically. Ask once, naming that
 * field, and retry this field after it is closed; failing it instead would leave every
 * later field empty behind the same popup. Defer/skip pauses the run with progress kept.
 */
async function afterBlockingPopup<T>(
  context: AgentContext,
  page: Page,
  blocked: boolean,
  retry: () => Promise<T>,
  current: T,
): Promise<T> {
  if (!blocked || !context.userInput || typeof page.applicationPopupBlocking !== 'function') return current;
  const owner = context.lastWrittenFieldLabel ? `「${context.lastWrittenFieldLabel}」` : '上一项';
  context.trace?.('网页弹层', 0, `${owner}的弹层未能自动收起，等待手动关闭`);
  await waitForApplicationPopup(context, async () => !(await page.applicationPopupBlocking()),
    `${owner}的弹层没能自动收起，请在网页上关闭它后继续填写。`);
  return retry();
}

/** Treat both endpoints as one interaction when the page commits them together. */
export async function writeApplicationDateRange(
  context: AgentContext,
  page: Page,
  start: { node: DOMElementNode; field: FormFieldReference; value: string; observedValue: string },
  end: { node: DOMElementNode; value: string; observedValue: string },
): Promise<[FormWriteResult, FormWriteResult]> {
  const once = () => context.controlExploration.run(start.field, context.controller.signal, signal =>
    page.pickApplicationDateRange([start.node, end.node], [start.value, end.value], [
      { observedValue: start.observedValue, signal }, { observedValue: end.observedValue, signal },
    ]));
  const results = await once();
  const blocked = results.every(result => result.code === 'PREVIOUS_POPUP_OPEN');
  if (!blocked) context.lastWrittenFieldLabel = start.field.label;
  const final = await afterBlockingPopup(context, page, blocked, once, results);
  if (final !== results && !final.every(result => result.code === 'PREVIOUS_POPUP_OPEN'))
    context.lastWrittenFieldLabel = start.field.label;
  return final;
}

/** observedValue belongs to the plan or question; an intervening edit cannot renew its authorization. */
export async function writeApplicationField(
  context: AgentContext,
  page: Page,
  request: FieldWrite,
): Promise<FormWriteResult> {
  const result = await writeFieldOnce(context, page, request);
  if (request.policy === 'direct_user_input') return result;
  return afterBlockingPopup(context, page, result.code === 'PREVIOUS_POPUP_OPEN',
    () => writeFieldOnce(context, page, request), result);
}

async function writeFieldOnce(
  context: AgentContext,
  page: Page,
  request: FieldWrite,
): Promise<FormWriteResult> {
  const manual = request.policy === 'direct_user_input';
  const guard = manual ? new ControlExploration() : context.controlExploration;
  const parent = manual ? new AbortController().signal : context.controller.signal;
  try {
    return await guard.run<FormWriteResult>(request.field, parent, async signal => {
      if (typeof page.prepareApplicationField === 'function') {
        if (!(await page.prepareApplicationField(request.node, signal))) {
          return { status: 'failed', code: 'PREVIOUS_POPUP_OPEN',
            message: '上一项的弹层尚未关闭，本项暂未操作。',
            adapter: 'field-transition', attempts: 0,
            actualValue: request.live?.value ?? request.observedValue ?? '', desiredValue: request.value };
        }
        // Dismissing the old popup may rerender the next control. Read it afresh
        // while retaining the original observedValue/replacement authorization.
        request = { ...request, live: undefined };
        if (!manual) context.lastWrittenFieldLabel = request.field.label;
      }
      const started = Date.now();
      const result = await performFieldWrite(context, page, request, signal);
      if (context.options?.debug && result.status === 'failed') {
        context.trace?.(
          '常规填写 · 原始失败',
          Date.now() - started,
          `${request.field.label} · ${result.code} · 候选 ${result.options?.length ?? 0} 项`,
        );
      }
      const retryable = [
        'UNSUPPORTED_CONTROL',
        'UNVERIFIABLE_CUSTOM_CONTROL',
        'OPTION_NOT_FOUND',
        'WRITE_FAILED',
        'VERIFY_FAILED',
        'READ_ONLY_CONTROL',
        'DATE_PANEL_STILL_OPEN',
        'DROPDOWN_STILL_OPEN',
        'CLICK_TARGET_OBSCURED',
        'NOT_ACCEPTED',
      ];
      if (
        result.status !== 'failed' ||
        !retryable.includes(result.code ?? '') ||
        Boolean(result.options?.length) ||
        !context.controlExplorer ||
        typeof page.openUnknownControl !== 'function' ||
        request.method === 'choose_many' ||
        request.method === 'check'
      )
        return result;
      // A technical fallback must not renew replacement permission or bypass a changed value.
      let live = await page.readApplicationControl(request.node, context.review.chosen(request.field));
      signal.throwIfAborted();
      if (
        live.connected === false ||
        live.disabled ||
        live.multiple ||
        live.kind === 'toggle' ||
        live.kind === 'select' ||
        // Rejected plain text (e.g. a salary unit) needs value replanning, not
        // unknown-widget exploration with an unchanged, rejected target value.
        (result.code === 'NOT_ACCEPTED' && live.kind === 'text' && !live.popup && !live.datePicker) ||
        (live.value.trim() && !formValuesEquivalent(live.value, request.value))
      )
        return result;
      if (['DATE_PANEL_STILL_OPEN', 'DROPDOWN_STILL_OPEN', 'CLICK_TARGET_OBSCURED', 'NOT_ACCEPTED'].includes(result.code) &&
        typeof page.prepareApplicationControlRecovery === 'function') {
        try {
          if (!(await page.prepareApplicationControlRecovery(request.node, signal))) return result;
        } catch (error) {
          if (error instanceof ExplorationStopped || error instanceof URLNotAllowedError || signal.aborted) throw error;
          return result;
        }
        live = await page.readApplicationControl(request.node, context.review.chosen(request.field));
        signal.throwIfAborted();
        if (live.connected === false || live.disabled ||
          (live.value.trim() && !formValuesEquivalent(live.value, request.value))) return result;
      }
      if (hasCommittedControlValue(live) && formValuesEquivalent(live.value, request.value)) {
        await new Promise(resolve => setTimeout(resolve, 180));
        const settled = await page.readApplicationControl(request.node, context.review.chosen(request.field));
        signal.throwIfAborted();
        if (settled.connected !== false && hasCommittedControlValue(settled) && settled.value === live.value)
          return { ...result, status: 'verified', code: 'VERIFIED', actualValue: settled.value,
            message: '控件恢复后两次回读已匹配，无需重复填写。' };
        return result;
      }
      await context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, `常规填写未完成，转入特殊控件探索 · ${request.field.label}`);
      return exploreUnknownControl(
        context,
        page,
        { node: request.node },
        request.field,
        request.value,
        signal,
        context.controlExplorer,
      );
    });
  } catch (error) {
    if (!(error instanceof ExplorationStopped)) throw error;
    return {
      status: 'failed',
      code: error.code,
      message: error.message,
      adapter: 'control-exploration',
      attempts: 0,
      actualValue: request.live?.value ?? request.observedValue ?? '',
      desiredValue: request.value,
    };
  }
}

async function performFieldWrite(
  context: AgentContext,
  page: Page,
  request: FieldWrite,
  signal?: AbortSignal,
): Promise<FormWriteResult> {
  signal?.throwIfAborted();
  const { node, field, value, policy, observedValue } = request;
  const live = request.live ?? (await page.readApplicationControl(node, context.review.chosen(field)));
  signal?.throwIfAborted();
  const settled = (status: FormWriteResult['status'], code: string, message: string): FormWriteResult => ({
    status,
    code,
    message,
    actualValue: live.value,
    desiredValue: value,
    attempts: 0,
    adapter: 'readback',
  });
  if (policy !== 'direct_user_input' && context.controller.signal.aborted) {
    return settled('failed', 'CANCELLED', '操作已取消。');
  }
  if (live.connected === false || (live.valueKnown === false && policy === 'approved_grant')) {
    return settled('failed', 'STALE_CONTROL', '无法核对当前控件，保留网页现状。');
  }
  if (formValuesEquivalent(live.value, value) && live.valueKnown !== false && live.selectionConfirmed !== false) {
    return live.valid
      ? settled('verified', 'ALREADY_MATCHED', '已核对当前值，无需重复写入。')
      : settled('failed', 'VALIDATION_REJECTED', live.validationMessage || '网页校验未通过。');
  }
  const permitted =
    policy === 'approved_grant' && context.replacements.permits(page.tabId, field.key, live.value, value);
  const baseline =
    policy === 'approved_grant'
      ? (context.replacements.confirmedFrom(page.tabId, field.key, value) ?? observedValue)
      : observedValue;
  const pageCascadeFilled = baseline === '' && live.value.trim() !== '' && !permitted;
  if (pageCascadeFilled) {
    if (live.disabled && hasCommittedControlValue(live)) {
      return {
        ...settled('verified', 'ALREADY_MATCHED', '已由网页联动自动生成，无需重复写入。'),
        desiredValue: live.value,
      };
    }
    const stripCategorySuffix = (s: string) => s.trim().replace(/(?:学类|大类|类|专业|方向)$/u, '').trim();
    if (
      live.valid !== false &&
      live.selectionConfirmed !== false &&
      stripCategorySuffix(live.value) !== '' &&
      formValuesEquivalent(stripCategorySuffix(live.value), stripCategorySuffix(value))
    ) {
      return {
        ...settled('verified', 'ALREADY_MATCHED', '已核对网页联动值，无需重复写入。'),
        desiredValue: live.value,
      };
    }
  }
  const canVerifyCascadeChoice =
    pageCascadeFilled &&
    Boolean(request.resolveOption) &&
    (Boolean(live.popup) || request.method === 'choose' || live.kind === 'select');
  if (baseline !== undefined && baseline !== live.value && !permitted && !canVerifyCascadeChoice) {
    if (policy === 'approved_grant') context.replacements.clearResolved(field.key);
    return settled('failed', 'VALUE_CHANGED', '字段已被修改，保留网页当前值，请核对。');
  }
  // Only direct edits from the authenticated feedback surface may write while automation is paused/stopped.
  const started = Date.now();
  const options: ApplicationControlOptions = {
    signal,
    observedValue: live.value,
    traceDropdown: context.options?.debug
      ? (phase, detail) => context.trace?.(`下拉 · ${phase}`, Date.now() - started, `${field.label} · ${detail}`)
      : undefined,
    resolveOption:
      request.resolveOption &&
      (async evidence =>
        signal
          ? explorationModel(signal, () => request.resolveOption!({ ...evidence, signal }))
          : request.resolveOption!(evidence)),
    allowReplace:
      policy === 'direct_user_input' ||
      permitted ||
      (request.method === 'type' && isSanitizationPlaceholder(live.value)),
  };
  if (request.method === 'check' || live.kind === 'toggle') {
    if (policy === 'approved_grant' && !permitted)
      return settled('preserved', 'EXISTING_VALUE_PRESERVED', '请确认当前值后再替换。');
    return page.clickApplicationToggle(node, signal, value === 'true');
  }
  if (request.method === 'choose_many' || live.multiple) {
    return page.selectCustomOptions(node, request.items?.length ? request.items : [value], options);
  }
  if (live.kind === 'select') return page.selectApplicationOption(node, value, options);
  if (live.datePicker || request.method === 'date') return page.pickApplicationDate(node, value, options);
  if ((live.popup || request.method === 'choose' || (!request.method && live.kind === 'custom')) &&
    live.choicePolicy !== 'free_text') {
    return page.selectCustomOption(node, value, options);
  }
  return (
    (await page.inputTextElementNode(request.useVision ?? false, node, value, options)) ??
    settled('failed', 'UNSUPPORTED_CONTROL', '未能写入该控件，请核对网页。')
  );
}

export function validPeer(live: Pick<FormControlState, 'valid' | 'value' | 'selectionConfirmed' | 'valueKnown'>, expected: string) {
  return (
    hasCommittedControlValue(live) &&
    live.value.trim() !== '' &&
    formValuesEquivalent(live.value, expected)
  );
}

export async function recheckValidationPeer(
  context: AgentContext,
  page: Page,
  node: DOMElementNode,
  field: FormFieldReference,
  expected: string,
  required: boolean,
): Promise<string | undefined> {
  const previous = context.review.entry(field);
  if (previous?.status === 'filled' && formValuesEquivalent(previous.actualValue, expected))
    return previous.actualValue;
  try {
    const live = await page.readApplicationControl(node, context.review.chosen(field));
    if (validPeer(live, expected)) {
      context.review.reconcile(field, live, live.required ?? required);
      context.formRetries.clearResolved(field.key);
      context.replacements.clearResolved(field.key);
      return live.value;
    }
  } catch (error) {
    if (error instanceof URLNotAllowedError) throw error;
    // The site may remove an observed field while redrawing a section. Leave it pending.
  }
  return undefined;
}

export async function recordApplicationFieldWrite(
  context: AgentContext,
  field: FormFieldReference,
  expected: string,
  result: FormWriteResult,
  required: boolean,
  meta?: ReviewControlMeta,
) {
  context.review.recordWrite(field, expected, result, required, meta);
  if (!isVerifiedWrite(result, expected)) return;
  context.formRetries.clearResolved(field.key);
  context.replacements.clearResolved(field.key);
  const peers = context.review
    .snapshot()
    .filter(
      entry =>
        entry.url === field.url &&
        entry.key !== field.key &&
        entry.status === 'failed' &&
        entry.failureCode === 'VALIDATION_REJECTED',
    );
  if (!peers.length) return;
  const state = await context.browserContext.getState();
  if (state.url !== field.url) return;
  const page = await context.browserContext.getCurrentPage();
  for (const [idx, node] of state.selectorMap) {
    const ref = formFieldReference(state, node, idx);
    const peer = peers.find(entry => entry.key === ref.key || (entry.legacyKey && entry.legacyKey === ref.legacyKey));
    if (!peer) continue;
    await recheckValidationPeer(context, page, node, ref, peer.expectedValue, peer.required);
  }
}
