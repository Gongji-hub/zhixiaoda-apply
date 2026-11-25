import { type FormWriteResult } from '../../browser/formFill';
import { validPeer } from '../writeApplicationField';
import { ApplicationDialogPending } from '../applicationDialog';
import { applyValues } from './applyValues';
import { formValuesKey, isSettledVerifiedField, openIssues, pruneDisconnectedFields, remember } from './fieldIssues';
import type { FormOutline } from './outline';
import { plan, prompt, readOutlineWithOptions, valuesSchema, type Run } from './planContext';
import { matchCachedSiteRules, recordVerifiedSiteRules } from './siteFieldCache';
import { URLNotAllowedError } from '../../browser/views';

export async function runValueRounds(run: Run, outline: FormOutline) {
  const { context } = run;
  let step: number;
  const cachedValues = await matchCachedSiteRules(context, outline);
  const cachedWritten = new Set<string>();
  let skipInitialPlan = false;
  if (cachedValues.length > 0 && !context.stopped) {
    step = Date.now();
    await applyValues(
      run,
      outline,
      cachedValues.flatMap(item =>
        item.value === null
          ? []
          : [
              {
                ...item,
                value: item.value,
                how: item.how === 'check' ? null : item.how,
              },
            ],
      ),
    );
    for (const id of run.written) cachedWritten.add(id);
    context.trace?.(
      '整页填写 · 缓存快填',
      Date.now() - step,
      `命中 ${cachedValues.length} 项 · 成功 ${run.written.size}`,
    );
    outline = await readOutlineWithOptions(run);
    const remaining = [...outline.fields.values()].filter(
      field =>
        !context.review.isSkipped(field.field) &&
        !context.review.isAutoDeferred(field.field) &&
        !run.written.has(field.id) &&
        !run.preserved.has(field.id) &&
        (context.review.entry(field.field)?.status === 'failed' ||
          !field.value.trim() ||
          !field.valid ||
          field.selectionConfirmed === false),
    );
    if (remaining.length === 0 && run.problems.size === 0) {
      skipInitialPlan = true;
    }
  }

  for (let round = 0; !skipInitialPlan && round < 3 && !context.stopped; round++) {
    if (round) {
      outline = await readOutlineWithOptions(run);
      pruneDisconnectedFields(run, outline);
      for (const [probId, prob] of [...run.problems]) {
        if (!prob.reason.startsWith('VALIDATION_REJECTED:')) continue;
        const freshField = outline.fields.get(probId);
        if (freshField && validPeer(freshField, prob.value)) {
          run.problems.delete(probId);
          const keyPrefix = `${JSON.stringify([freshField.field.key]).slice(0, -1)},`;
          for (const key of [...run.failedAttempts]) {
            if (key.startsWith(keyPrefix)) run.failedAttempts.delete(key);
          }
          run.written.add(probId);
          const prevEntry = context.review.entry(freshField.field);
          await run.record(
            context,
            {
              status: 'verified',
              code: 'VERIFIED',
              message: '关联字段补齐后网页校验已通过。',
              adapter: (prevEntry?.adapter as FormWriteResult['adapter']) ?? 'native-input',
              attempts: 1,
              actualValue: freshField.value,
              desiredValue: freshField.value,
            },
            freshField.field,
            prob.value,
            freshField.required,
          );
        }
      }
    }
    const issues = round ? openIssues(run, outline).trim() : '';
    const hasInitialRejected =
      !round &&
      [...outline.fields.values()].some(field => {
        const entry = context.review.entry(field.field);
        return Boolean(
          entry &&
            entry.status === 'failed' &&
            !entry.autoDeferred &&
            !['MISSING_INFORMATION', 'DATE_PRECISION_REQUIRED', 'OPTIONAL_MISSING'].includes(entry.failureCode ?? ''),
        );
      });
    const initialIssues =
      !round && (run.problems.size > 0 || run.unexpressedDetails.size > 0 || hasInitialRejected)
        ? openIssues(run, outline).trim()
        : '';
    run.pendingOptionReplan.clear();
    run.unexpressedDetails.clear();
    if (round && !issues) break;
    for (const field of outline.fields.values()) run.plannedFieldKeys.add(field.field.key);
    const isCollapsedField = (id: string): boolean => {
      const f = outline.fields.get(id);
      if (!f || run.problems.has(id)) return false;
      return (!round && cachedWritten.has(id)) || isSettledVerifiedField(run, f);
    };
    const planOutline = [...outline.fields.keys()].some(isCollapsedField)
      ? {
          ...outline,
          items: outline.items.map(item =>
            item.type === 'field' && isCollapsedField(item.id) && !item.dateRange?.ids.some(id => !isCollapsedField(id))
              ? { type: 'text' as const, text: `已填 · ${item.label} = ${item.value}` }
              : item,
          ),
        }
      : outline;
    const values = round
      ? await plan(run, valuesSchema, '修复方案', prompt(run, planOutline, `\n失败记录与待处理：\n${issues}`))
      : await plan(
          run,
          valuesSchema,
          '填写方案',
          prompt(run, planOutline, initialIssues ? `\n失败记录与待处理：\n${initialIssues}` : ''),
        );
    context.trace?.('整页填写 · 方案内容', 0, `写 ${values.values.length} 项 · 问 ${values.ask.length} 项`);
    if (!values.values.length) {
      await remember(run, outline, values.ask);
      if (run.pendingOptionReplan.size > 0) continue;
      break;
    }
    step = Date.now();
    const before = formValuesKey(outline);
    const attempted = await applyValues(run, outline, values.values);
    await recordVerifiedSiteRules(context, outline, values.values, run.written);
    await remember(run, outline, values.ask);
    context.trace?.('整页填写 · 写入', Date.now() - step, `成功 ${run.written.size} · 待处理 ${run.problems.size}`);
    const refreshedAfterRound = round > 0 ? await readOutlineWithOptions(run) : null;
    if (refreshedAfterRound) {
      outline = refreshedAfterRound;
      pruneDisconnectedFields(run, outline);
    }
    if (
      !attempted ||
      (refreshedAfterRound !== null &&
        before === formValuesKey(refreshedAfterRound) &&
        run.pendingOptionReplan.size === 0 &&
        run.unexpressedDetails.size === 0)
    ) {
      if (run.pendingOptionReplan.size > 0 || run.unexpressedDetails.size > 0) continue;
      context.trace?.('整页填写 · 停止无进展修复', 0, '保留失败记录，交回逐项处理。');
      break;
    }
  }

  return outline;
}

/** Recheck unanswered fields against the profile before asking the user. */
export async function reconcileUnfilledFields(run: Run, outline: FormOutline): Promise<FormOutline> {
  const { context } = run;
  if (context.stopped || !context.options.targetOrigin) return outline;
  outline = await readOutlineWithOptions(run);
  // Fields skipped only because another popup was still open have no failed attempt
  // of their own; recheck them here instead of leaving every later field empty.
  const triedAndFailed = (id: string) => {
    const problem = run.problems.get(id);
    return Boolean(problem && !problem.reason.startsWith('PREVIOUS_POPUP_OPEN:'));
  };
  const remaining = [...outline.fields.values()].filter(field =>
    field.valueKnown && (!field.value.trim() || !field.valid || field.selectionConfirmed === false) &&
    (!field.readOnly || field.datePicker || field.kind === 'combobox' || field.kind === 'select') &&
    !context.review.isSkipped(field.field) && !context.review.isAutoDeferred(field.field) &&
    !run.resolvedRevealToggles.has(field.field.key) && !triedAndFailed(field.id),
  );
  if (!remaining.length) return outline;
  const ids = new Set(remaining.map(field => field.id));
  const draftQuestions = remaining.flatMap(field => {
    const question = run.asks.get(field.id);
    return question ? [{ id: field.id, question }] : [];
  });
  try {
    const values = await plan(
      run, valuesSchema, '修复方案', prompt(run, outline,
        `整页填写后的资料对照。请逐项检查这些当前仍为空或未通过校验的控件：${[...ids].join('、')}。\n` +
        `此前拟向用户提问的字段（这些问题尚未发出，缺资料的判断待复核）：${JSON.stringify(draftQuestions)}。\n` +
        '仅返回这些控件的动作。结合字段附近文字、控件类型和已经确认的资料重新匹配，核对个人资料的 applicationInfo.custom_fields 和 supplement_markdown 中用不同名称表达的同一事实。已有明确值就补填，包括选填字段和已保存的多行描述。仍缺少依据时才保留必填项提问。保持已有网页值和已暂缓的字段。'),
    );
    const writes = values.values.filter(item => ids.has(item.id) && !item.ai_inferred && item.value.trim());
    if (writes.length) await applyValues(run, outline, writes);
    await remember(run, outline, values.ask.filter(ask => ask.id !== null && ids.has(ask.id)));
    context.trace?.('整页填写 · 资料对照', 0, `复核 ${ids.size} 项，其中待提问 ${draftQuestions.length} 项，安排补填 ${writes.length} 项`);
    return writes.length ? readOutlineWithOptions(run) : outline;
  } catch (error) {
    context.controller.signal.throwIfAborted();
    if (error instanceof URLNotAllowedError || error instanceof ApplicationDialogPending) throw error;
    context.trace?.('整页填写 · 资料对照未完成', 0, error instanceof Error ? error.message : '判断服务暂时不可用。');
    return outline;
  }
}
