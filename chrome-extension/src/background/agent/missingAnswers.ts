import { formValuesEquivalent } from '../browser/formFill';
import type { DecisionClient } from '../decisionClient';
import { containsSanitizationPlaceholder } from '../services/guardrails/patterns';
import { formWriteActionResult } from './actions/writeResult';
import { waitForApplicationDialog } from './applicationDialog';
import { hasConfirmedPrivacyConsent, isStrictPrivacyTermsLabel } from './applicationEvidence';
import { Actors, ExecutionState } from './event/types';
import { fillApplicationForm } from './formPlan/fill';
import { optionResolver } from './formPlan/optionResolver';
import { fieldKind, waitForApplicationResume } from './formPlan/outline';
import { formFieldReference, type FormReviewEntry } from './formReview';
import { findLiveControlNode, isAbortStopError, isObscuredWriteResult } from './postFillChecks';
import { ActionResult, type AgentContext } from './types';
import type { UserQuestion } from './userInput';
import { writeApplicationField } from './writeApplicationField';

const AFFIRMATIVE_ANSWER_RE = /^(同意|已同意|是|确认|true|1)$/iu;
const EXPLICIT_DATE_RE = /^\s*\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?|月)?\s*$/u;

function buildDirectQuestionText(entry: FormReviewEntry, hasOptions: boolean): string {
  let text = (entry.message || '').replace(/^需要用户提供[：:]\s*/, '').trim();
  if (hasOptions) {
    text = text.replace(/（可选项：[\s\S]*?）\s*$/, '').trim();
  }
  text = text.replace(/（拟写入「[\s\S]*?」，回读为「[\s\S]*?」）\s*$/, '').trim();
  if (!text) return `请补充「${entry.label || '此项'}」的信息。`;
  if (
    !entry.message.startsWith('需要用户提供') &&
    entry.label &&
    entry.label !== '控件' &&
    !text.includes(entry.label)
  ) {
    return `「${entry.label}」：${text}`;
  }
  return text;
}
export async function handleMissingAnswers(
  context: AgentContext,
  extractorLLM: DecisionClient,
  handledNotes: string[],
) {
  let followUpRan = false;
  let obscuredByOverlay: string | null = null;
  for (let pass = 0; pass < 2 && !context.stopped && !obscuredByOverlay; pass++) {
    const missingEntries = context.review
      .snapshot()
      .filter(
        entry =>
          !context.review.isSkipped(entry) &&
          !entry.autoDeferred &&
          ['MISSING_INFORMATION', 'DATE_PRECISION_REQUIRED'].includes(entry.failureCode ?? '') &&
          ['pending', 'failed'].includes(entry.status),
      );
    if (!missingEntries.length) break;

    let needsFollowUpFill = false;
    let pageHasRequiredMarkers: boolean | undefined;

    for (const queued of missingEntries) {
      await waitForApplicationResume(context);
      await waitForApplicationDialog(context);
      const latest = context.review.entry(queued);
      if (!latest || context.review.isSkipped(latest) || ['filled', 'preserved'].includes(latest.status)) {
        continue;
      }

      const state = await context.browserContext.getState();
      const page = await context.browserContext.getCurrentPage();
      await context.browserContext.assertApplyTarget(page.tabId);
      if (state.url !== latest.url) continue;

      const located = findLiveControlNode(state, latest);
      if (!located) {
        if (!followUpRan) {
          needsFollowUpFill = true;
          continue;
        }
        if (!latest.required) {
          context.review.removeField(latest);
          await context.emitEvent(
            Actors.SYSTEM,
            ExecutionState.REVIEW_UPDATED,
            JSON.stringify(context.review.snapshot()),
          );
        }
        continue;
      }

      const { node: targetNode, index: targetIndex } = located;
      const field = formFieldReference(state, targetNode, targetIndex);
      const live = await page.readApplicationControl(targetNode, context.review.chosen(latest));
      const required =
        live.required ??
        (targetNode.attributes.required !== undefined || targetNode.attributes['aria-required'] === 'true');

      if (
        latest.failureCode !== 'DATE_PRECISION_REQUIRED' &&
        live.kind !== 'toggle' &&
        live.valid &&
        live.selectionConfirmed !== false &&
        live.value.trim() !== ''
      ) {
        context.review.reconcile(field, live, required);
        await context.emitEvent(
          Actors.SYSTEM,
          ExecutionState.REVIEW_UPDATED,
          JSON.stringify(context.review.snapshot()),
        );
        continue;
      }

      const baseKind = fieldKind(targetNode);
      const controlKind = baseKind === 'text' && live.popup ? 'combobox' : baseKind;
      const isToggle = ['checkbox', 'radio', 'switch'].includes(controlKind ?? '');
      const isConsentToggle = isToggle && isStrictPrivacyTermsLabel(`${field.label} ${latest.message}`);

      if (!isConsentToggle && !required) {
        // Use live markers, including custom form labels already tagged by the
        // whole-form scan. An old review entry is not evidence of a requirement.
        pageHasRequiredMarkers ??=
          [...state.selectorMap.values()].some(node => node.attributes.required !== undefined || node.attributes['aria-required'] === 'true') ||
          [...(await page.readTaggedControls()).values()].some(control => control.required);
        if (pageHasRequiredMarkers) {
          if (field.key !== latest.key) context.review.removeField(latest);
          context.review.recordOptionalMissing(field);
          await context.emitEvent(Actors.SYSTEM, ExecutionState.REVIEW_UPDATED, JSON.stringify(context.review.snapshot()));
          continue;
        }
      }

      if (isConsentToggle && hasConfirmedPrivacyConsent(context) && typeof page.clickApplicationToggle === 'function') {
        const toggled = await writeApplicationField(context, page, {
          node: targetNode,
          field,
          value: 'true',
          method: 'check',
          policy: 'never',
          observedValue: live.value,
        });
        await formWriteActionResult(context, toggled, field, 'true', required);
        if (isObscuredWriteResult(toggled)) {
          obscuredByOverlay = `${field.label}：${toggled.message}`;
          break;
        }
        if (toggled.status === 'verified') {
          handledNotes.push(`${field.label}：已按授权自动勾选`);
          continue;
        }
      }

      const questionInput: Omit<UserQuestion, 'id'> = {
        kind: 'information',
        question: '',
        reason: latest.message || `需要补充「${field.label}」`,
        options: [],
        field,
      };

      if ((controlKind === 'combobox' || controlKind === 'select') && !live.datePicker) {
        try {
          const rawOptions = latest.options?.length
            ? latest.options
            : await context.controlExploration.run(field, context.controller.signal, signal => page.listControlOptions(targetNode, signal));
          const deduped = [...new Set(rawOptions)];
          if (!deduped.length) throw new Error('候选尚未加载');
          questionInput.options = deduped;
          questionInput.multiple = live.multiple === true;
        } catch (err) {
          if (isAbortStopError(context, err)) throw err;
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes('CLICK_TARGET_OBSCURED')) {
            obscuredByOverlay = `${field.label}：${errMsg.replace(/^CLICK_TARGET_OBSCURED:\s*/, '')}`;
            break;
          }
          questionInput.kind = 'manual_action';
          questionInput.question = `请在网页选择「${field.label}」，选好后继续。`;
          questionInput.options = [];
        }
      } else if (isConsentToggle) {
        questionInput.options = ['同意'];
      }

      if (!questionInput.question) {
        questionInput.question = buildDirectQuestionText(latest, questionInput.options.length > 0);
      }

      context.trace?.('直接提问', 0, `${field.label}：${questionInput.question}`);
      const answer = await context.userInput.ask(questionInput, context.controller.signal, question =>
        context.emitEvent(Actors.SYSTEM, ExecutionState.USER_QUESTION, JSON.stringify(question)),
      );
      await waitForApplicationDialog(context);

      if (answer.decision === 'skip') {
        handledNotes.push(`${field.label}：用户选择跳过`);
        continue;
      }
      if (answer.decision === 'defer') {
        handledNotes.push(`${field.label}：用户选择稍后自行处理`);
        continue;
      }
      if (questionInput.kind === 'manual_action') {
        const freshLive = await page.readApplicationControl(targetNode, true);
        context.review.verifyManualEdit(field, freshLive, freshLive.required ?? required);
        await context.emitEvent(
          Actors.SYSTEM,
          ExecutionState.REVIEW_UPDATED,
          JSON.stringify(context.review.snapshot()),
        );
        handledNotes.push(`${field.label}：用户已在网页处理`);
        continue;
      }

      const trimmed = answer.text.trim();
      if (!trimmed || containsSanitizationPlaceholder(trimmed)) continue;

      if (isConsentToggle && AFFIRMATIVE_ANSWER_RE.test(trimmed) && typeof page.clickApplicationToggle === 'function') {
        const writeResult = await writeApplicationField(context, page, {
          node: targetNode,
          field,
          value: 'true',
          method: 'check',
          policy: 'never',
          observedValue: live.value,
        });
        await formWriteActionResult(context, writeResult, field, 'true', required);
        if (isObscuredWriteResult(writeResult)) {
          obscuredByOverlay = `${field.label}：${writeResult.message}`;
          break;
        }
        handledNotes.push(`${field.label}：已确认勾选`);
        continue;
      }

      if (isToggle) {
        context.review.recordFailure(
          field,
          `用户对「${field.label}」回答「${trimmed}」，请结合选项或勾选状态写入`,
          required,
          undefined,
          { failureCode: 'USER_ANSWER_PENDING', autoDeferred: false },
        );
        needsFollowUpFill = true;
        handledNotes.push(`${field.label}：用户回答「${trimmed}」`);
        continue;
      }

      if (controlKind === 'combobox' || controlKind === 'select') {
        let currentAnswer: typeof answer | null = answer;
        let currentOptions = questionInput.options;
        let answerObservedValue = live.value;
        for (let subStep = 0; subStep < 4 && currentAnswer; subStep++) {
          const subTrimmed = currentAnswer.text.trim();
          if (!subTrimmed || containsSanitizationPlaceholder(subTrimmed)) break;
          const matchedOption = currentOptions.find(opt => formValuesEquivalent(opt, subTrimmed));
          const selectedOptions = questionInput.multiple
            ? (currentAnswer.selectedOptions ?? [subTrimmed])
            : [matchedOption ?? subTrimmed];
          const chosenText = selectedOptions.join('、');
          const writeResult = await writeApplicationField(context, page, {
            node: targetNode,
            field,
            value: chosenText,
            items: selectedOptions,
            method: questionInput.multiple ? 'choose_many' : 'choose',
            policy: 'never',
            observedValue: answerObservedValue,
            resolveOption:
              !matchedOption && typeof extractorLLM?.decide === 'function'
                ? optionResolver(context, extractorLLM, field.label)
                : undefined,
          });
          if (isObscuredWriteResult(writeResult)) {
            await formWriteActionResult(context, writeResult, field, chosenText, required);
            obscuredByOverlay = `${field.label}：${writeResult.message}`;
            break;
          }
          if (
            !questionInput.multiple &&
            subStep < 3 &&
            writeResult.code === 'MISSING_INFORMATION' &&
            writeResult.options?.length
          ) {
            const nextOptions = [...new Set(writeResult.options)];
            if (nextOptions.length > 0 && nextOptions.join('\n') !== currentOptions.join('\n')) {
              await formWriteActionResult(context, writeResult, field, chosenText, required);
              currentOptions = nextOptions;
              const subEntry = context.review.entry(field) ?? {
                ...latest,
                ...field,
                message: writeResult.message,
                options: nextOptions,
              };
              const subQuestion: Omit<UserQuestion, 'id'> = {
                kind: 'information',
                question: buildDirectQuestionText(subEntry, true),
                reason: writeResult.message,
                options: nextOptions,
                field,
              };
              context.trace?.('直接提问', 0, `${field.label}：${subQuestion.question}`);
              answerObservedValue = (await page.readApplicationControl(targetNode, true)).value;
              const nextAnswer = await context.userInput.ask(subQuestion, context.controller.signal, q =>
                context.emitEvent(Actors.SYSTEM, ExecutionState.USER_QUESTION, JSON.stringify(q)),
              );
              if (nextAnswer.decision === 'skip') {
                handledNotes.push(`${field.label}：用户选择跳过`);
                break;
              }
              if (nextAnswer.decision === 'defer') {
                handledNotes.push(`${field.label}：用户选择稍后自行处理`);
                break;
              }
              currentAnswer = nextAnswer;
              continue;
            }
          }
          await formWriteActionResult(context, writeResult, field, chosenText, required);
          handledNotes.push(
            `${field.label}：${writeResult.status === 'verified' ? `已选「${chosenText}」` : writeResult.message}`,
          );
          break;
        }
        if (obscuredByOverlay) break;
        continue;
      }

      const isDateField =
        Boolean(live.datePicker) ||
        latest.failureCode === 'DATE_PRECISION_REQUIRED' ||
        (live.readOnly && /^\s*\d{4}\D+\d{1,2}/.test(trimmed));
      if (isDateField) {
        if (!live.dateRange && EXPLICIT_DATE_RE.test(trimmed)) {
          const normalizedDate = trimmed
            .replace(/[年月/.]+/g, '-')
            .replace(/(?:日|-)+\s*$/u, '')
            .trim();
          const writeResult = await writeApplicationField(context, page, {
            node: targetNode,
            field,
            value: normalizedDate,
            method: 'date',
            policy: 'never',
            observedValue: live.value,
          });
          if (isObscuredWriteResult(writeResult)) {
            await formWriteActionResult(context, writeResult, field, normalizedDate, required);
            obscuredByOverlay = `${field.label}：${writeResult.message}`;
            break;
          }
          if (
            writeResult.status === 'verified' ||
            writeResult.code === 'VALUE_CHANGED' ||
            writeResult.status === 'preserved' ||
            followUpRan
          ) {
            await formWriteActionResult(context, writeResult, field, normalizedDate, required);
            handledNotes.push(
              `${field.label}：${writeResult.status === 'verified' ? `已填「${normalizedDate}」` : writeResult.message}`,
            );
          } else {
            const ctxHint = writeResult.fieldText ? `；附近文字「${writeResult.fieldText.slice(0, 120)}」` : '';
            context.review.recordFailure(
              field,
              `原样填入用户回答「${trimmed}」未被网页接受（${writeResult.code}：${writeResult.message}${ctxHint}），请按字段日期格式约束转换后写入`,
              required,
              undefined,
              { failureCode: writeResult.code, autoDeferred: false },
            );
            needsFollowUpFill = true;
            handledNotes.push(`${field.label}：用户回答「${trimmed}」`);
          }
        } else {
          context.review.recordFailure(
            field,
            `用户对「${field.label}」回答「${trimmed}」，请结合字段日期格式约束写入`,
            required,
            undefined,
            { failureCode: 'USER_ANSWER_PENDING', autoDeferred: false },
          );
          needsFollowUpFill = true;
          handledNotes.push(`${field.label}：用户回答「${trimmed}」`);
        }
        continue;
      }

      if (!live.readOnly) {
        const writeResult = await writeApplicationField(context, page, {
          node: targetNode,
          field,
          value: trimmed,
          method: 'type',
          policy: 'never',
          observedValue: live.value,
        });
        if (writeResult) {
          if (isObscuredWriteResult(writeResult)) {
            await formWriteActionResult(context, writeResult, field, trimmed, required);
            obscuredByOverlay = `${field.label}：${writeResult.message}`;
            break;
          }
          if (
            writeResult.status === 'verified' ||
            writeResult.code === 'VALUE_CHANGED' ||
            writeResult.status === 'preserved' ||
            followUpRan
          ) {
            await formWriteActionResult(context, writeResult, field, trimmed, required);
            handledNotes.push(
              `${field.label}：${writeResult.status === 'verified' ? `已填「${trimmed}」` : writeResult.message}`,
            );
          } else {
            const ctxHint = writeResult.fieldText ? `；附近文字「${writeResult.fieldText.slice(0, 120)}」` : '';
            context.review.recordFailure(
              field,
              `原样填入用户回答「${trimmed}」未被网页接受（${writeResult.code}：${writeResult.message}${ctxHint}），请按字段单位或格式约束转换后写入`,
              required,
              undefined,
              { failureCode: writeResult.code, autoDeferred: false },
            );
            needsFollowUpFill = true;
            handledNotes.push(`${field.label}：用户回答「${trimmed}」（待按字段格式转换填入）`);
          }
        }
      } else {
        context.review.recordFailure(
          field,
          `用户对「${field.label}」回答「${trimmed}」，请结合控件交互方式写入`,
          required,
          undefined,
          { failureCode: 'USER_ANSWER_PENDING', autoDeferred: false },
        );
        needsFollowUpFill = true;
        handledNotes.push(`${field.label}：用户回答「${trimmed}」`);
      }
    }

    if (obscuredByOverlay) break;

    if (needsFollowUpFill && !followUpRan && !context.stopped && !context.paused) {
      followUpRan = true;
      await context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, '根据补充信息更新表单');
      const followSummary = await fillApplicationForm(context, extractorLLM, formWriteActionResult);
      const postState = await context.browserContext.getCachedState().catch(() => null);
      if (followSummary.startsWith('整页填写结束')) {
        context.lastFullFillMeta = {
          url: postState?.url ?? context.lastFullFillMeta?.url ?? '',
          hasPreservedConflicts: followSummary.includes('已有内容与资料不同（未覆盖'),
          hasStructureProblems: followSummary.includes('区块未补齐（'),
        };
      }
      context.actionResults = [new ActionResult({ extractedContent: followSummary, includeInMemory: true })];
      await context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, '补充信息更新完成');
    } else {
      break;
    }
  }
  return obscuredByOverlay;
}
