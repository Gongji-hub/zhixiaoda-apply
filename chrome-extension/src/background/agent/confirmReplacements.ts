import { formValuesEquivalent } from '../browser/formFill';
import type { DecisionClient } from '../decisionClient';
import { formWriteActionResult } from './actions/writeResult';
import { waitForApplicationDialog } from './applicationDialog';
import { Actors, ExecutionState } from './event/types';
import { optionResolver } from './formPlan/optionResolver';
import { fieldKind, waitForApplicationResume } from './formPlan/outline';
import { formFieldReference, type FormReviewEntry } from './formReview';
import { findLiveControlNode, isObscuredWriteResult } from './postFillChecks';
import { type AgentContext } from './types';
import { writeApplicationField } from './writeApplicationField';

export async function confirmReplacements(context: AgentContext, extractorLLM: DecisionClient, handledNotes: string[]) {
  let obscuredByOverlay: string | null = null;
  if (!obscuredByOverlay && !context.stopped && !context.paused) {
    const preservedEntries = context.review
      .snapshot()
      .filter(
        entry =>
          !context.review.isSkipped(entry) &&
          entry.status === 'failed' &&
          entry.failureCode === 'EXISTING_VALUE_PRESERVED' &&
          entry.expectedValue.trim() !== '',
      );
    if (preservedEntries.length > 0) {
      const state = await context.browserContext.getState();
      const page = await context.browserContext.getCurrentPage();
      await context.browserContext.assertApplyTarget(page.tabId);
      const conflictItems: {
        field: FormReviewEntry;
        controlKind: ReturnType<typeof fieldKind>;
        currentValue: string;
        proposedValue: string;
        required: boolean;
        tabId: number;
      }[] = [];

      for (const entry of preservedEntries) {
        if (entry.url !== state.url) continue;
        const located = findLiveControlNode(state, entry);
        if (!located) continue;
        const field = {
          ...formFieldReference(state, located.node, located.index),
          key: entry.key,
          legacyKey: entry.legacyKey,
        };
        const live = await page.readApplicationControl(located.node, context.review.chosen(entry));
        const required = Boolean(
          live.required ||
            located.node.attributes.required !== undefined ||
            located.node.attributes['aria-required'] === 'true' ||
            entry.required,
        );
        if (
          formValuesEquivalent(live.value, entry.expectedValue) ||
          (entry.requestedValue ? formValuesEquivalent(live.value, entry.requestedValue) : false)
        ) {
          context.review.reconcile(field, live, required);
          continue;
        }
        if (!live.value.trim()) continue;
        conflictItems.push({
          field: { ...entry, ...field },
          controlKind: fieldKind(located.node),
          currentValue: live.value,
          proposedValue: entry.expectedValue,
          required,
          tabId: page.tabId,
        });
      }

      if (conflictItems.length > 0) {
        await waitForApplicationResume(context);
        await waitForApplicationDialog(context);
        const replacements = conflictItems.map(item => ({
          field: item.field,
          currentValue: item.currentValue,
          proposedValue: item.proposedValue,
          tabId: item.tabId,
        }));
        const answer = await context.userInput.ask(
          {
            kind: 'information',
            question: `是否替换以下 ${replacements.length} 处字段？`,
            reason: '确认仅适用于下方列出的字段及替换值。',
            options: [],
            field: conflictItems[0].field,
            replacement: {
              currentValue: conflictItems[0].currentValue,
              proposedValue: conflictItems[0].proposedValue,
              tabId: conflictItems[0].tabId,
            },
            replacements,
          },
          context.controller.signal,
          q => context.emitEvent(Actors.SYSTEM, ExecutionState.USER_QUESTION, JSON.stringify(q)),
        );
        await waitForApplicationResume(context);
        await waitForApplicationDialog(context);
        if (answer.decision === 'confirm_replace') {
          for (const item of conflictItems) {
            if (context.stopped || context.paused) break;
            const currentState = await context.browserContext.getState();
            const located =
              currentState.url === item.field.url && currentState.tabId === item.tabId
                ? findLiveControlNode(currentState, item.field)
                : null;
            if (!located) {
              context.replacements.clearResolved(item.field.key);
              context.review.recordFailure(item.field, '确认后页面或字段已变更，请重新核对。', item.required);
              continue;
            }
            const writeResult = await writeApplicationField(context, page, {
              node: located.node,
              field: item.field,
              value: item.proposedValue,
              policy: 'approved_grant',
              observedValue: item.currentValue,
              method: item.controlKind === 'combobox' || context.review.chosen(item.field) ? 'choose' : undefined,
              items: item.proposedValue
                .split(/[、,，\n]+/)
                .map(s => s.trim())
                .filter(Boolean),
              resolveOption:
                typeof extractorLLM?.decide === 'function'
                  ? optionResolver(context, extractorLLM, item.field.label)
                  : undefined,
            });
            if (writeResult) {
              await formWriteActionResult(context, writeResult, item.field, item.proposedValue, item.required);
              if (isObscuredWriteResult(writeResult)) {
                obscuredByOverlay = `${item.field.label}：${writeResult.message}`;
                break;
              }
              handledNotes.push(
                `${item.field.label}：${writeResult.status === 'verified' ? `已替换为「${writeResult.actualValue}」` : writeResult.message}`,
              );
            }
          }
        } else if (answer.decision === 'skip') {
          handledNotes.push(`保留原值：${conflictItems.map(item => item.field.label).join('、')}`);
        } else if (answer.decision === 'defer') {
          handledNotes.push(`稍后处理：${conflictItems.map(item => item.field.label).join('、')}`);
        }
      }
      if (context.lastFullFillMeta && context.lastFullFillMeta.url === state.url) {
        context.lastFullFillMeta.hasPreservedConflicts = false;
      }
    }
  }
  return obscuredByOverlay;
}
