import { ActionResult, type AgentContext } from '@src/background/agent/types';
import type { z } from 'zod';
import { formValuesEquivalent } from '../../browser/formFill';
import { hasConfirmedPrivacyConsent, isStrictPrivacyTermsLabel } from '../applicationEvidence';
import { Actors, ExecutionState } from '../event/types';
import { fieldKind } from '../formPlan/outline';
import { formFieldReference } from '../formReview';
import { writeApplicationField } from '../writeApplicationField';
import { Action } from './action';
import { askUserSchema, prepareQuestion } from './prepareQuestion';
import { formWriteActionResult } from './writeResult';

export function createQuestionAction(context: AgentContext) {

  const question = new Action(async (input: z.infer<typeof askUserSchema.schema>) => {
      const prepared = await prepareQuestion(context, input);
      if (prepared instanceof ActionResult) return prepared;
      const { questionInput, targetNode, answerObservedValue } = prepared;
      const isConsentPrompt = isStrictPrivacyTermsLabel(
        `${questionInput.field?.label ?? ''} ${questionInput.question}`,
      );
      if (
        isConsentPrompt &&
        !questionInput.replacement &&
        hasConfirmedPrivacyConsent(context) &&
        targetNode &&
        ['checkbox', 'radio', 'switch'].includes(fieldKind(targetNode) ?? '') &&
        questionInput.field
      ) {
        try {
          const page = await context.browserContext.getCurrentPage();
          if (typeof page.clickApplicationToggle === 'function') {
            const required =
              targetNode.attributes.required !== undefined || targetNode.attributes['aria-required'] === 'true';
            const writeResult = await writeApplicationField(context, page, {
              field: questionInput.field,
              node: targetNode,
              value: 'true',
              method: 'check',
              policy: 'never',
            });
            await formWriteActionResult(context, writeResult, questionInput.field, 'true', required);
            if (writeResult.status === 'verified') {
              return new ActionResult({
                success: true,
                includeInMemory: true,
                extractedContent: JSON.stringify({
                  question: questionInput.question,
                  autoFilled: {
                    field: questionInput.field.label,
                    value: 'true',
                    status: 'verified',
                  },
                  instruction:
                    'User profile already authorizes recruiting privacy/terms consent and the checkbox has ALREADY been checked and verified on the page. Do not ask or write this field again. Continue remaining fields or call done.',
                }),
              });
            }
          }
        } catch {
          /* Fall back to asking the user if auto-toggle fails. */
        }
      }
      if (questionInput.kind === 'information' && !questionInput.replacement) {
        if (!questionInput.options.length && isConsentPrompt) {
          questionInput.options = ['同意'];
        }
      }
      const answer = await context.userInput.ask(questionInput, context.controller.signal, question =>
        context.emitEvent(Actors.SYSTEM, ExecutionState.USER_QUESTION, JSON.stringify(question)),
      );
      if (
        answer.decision === 'answer' &&
        isConsentPrompt &&
        /^(同意|已同意|是|确认|true|1)$/iu.test(answer.text.trim()) &&
        !questionInput.replacement
      ) {
        try {
          const page = await context.browserContext.getCurrentPage();
          const state = context.options.targetOrigin ? page.getCachedState() : await page.getState();
          let consentNode = targetNode;
          let consentField = questionInput.field;
          if ((!consentNode || !['checkbox', 'radio', 'switch'].includes(fieldKind(consentNode) ?? '')) && state) {
            for (const [idx, node] of state.selectorMap) {
              if (['checkbox', 'radio', 'switch'].includes(fieldKind(node) ?? '')) {
                const candidateField = formFieldReference(state, node, idx);
                if (/同意|已阅读|隐私|协议|条款|承诺|知情|授权/.test(candidateField.label)) {
                  consentNode = node;
                  consentField = candidateField;
                  break;
                }
              }
            }
          }
          if (
            consentNode &&
            consentField &&
            ['checkbox', 'radio', 'switch'].includes(fieldKind(consentNode) ?? '') &&
            typeof page.clickApplicationToggle === 'function'
          ) {
            const required =
              consentNode.attributes.required !== undefined || consentNode.attributes['aria-required'] === 'true';
            const writeResult = await writeApplicationField(context, page, {
              field: consentField,
              node: consentNode,
              value: 'true',
              method: 'check',
              policy: 'never',
            });
            await formWriteActionResult(context, writeResult, consentField, 'true', required);
            if (writeResult.status === 'verified') {
              return new ActionResult({
                success: true,
                includeInMemory: true,
                extractedContent: JSON.stringify({
                  question: questionInput.question,
                  userResponse: answer,
                  autoFilled: {
                    field: consentField.label,
                    value: 'true',
                    status: 'verified',
                  },
                  instruction:
                    'User confirmed consent and the checkbox has ALREADY been checked and verified on the page. Do not write this field again. Continue other remaining fields or call done.',
                }),
              });
            }
          }
        } catch {
          /* Fall back to normal answer return if direct toggle fails. */
        }
      }
      if (
        answer.decision === 'answer' &&
        answer.text.trim() &&
        questionInput.kind === 'information' &&
        !questionInput.replacement &&
        targetNode &&
        questionInput.field
      ) {
        const controlKind = fieldKind(targetNode);
        const trimmed = answer.text.trim();
        const matchedOption = questionInput.options.find(opt => formValuesEquivalent(opt, trimmed));
        const selectedOptions = questionInput.multiple ? answer.selectedOptions : matchedOption ? [matchedOption] : [];
        if ((controlKind === 'combobox' || controlKind === 'select') && selectedOptions?.length) {
          try {
            const page = await context.browserContext.getCurrentPage();
            const required =
              targetNode.attributes.required !== undefined || targetNode.attributes['aria-required'] === 'true';
            const writeResult = await writeApplicationField(context, page, {
              node: targetNode,
              field: questionInput.field,
              value: selectedOptions.join('、'),
              method: questionInput.multiple ? 'choose_many' : 'choose',
              policy: 'never',
              observedValue: answerObservedValue,
              items: selectedOptions,
            });
            await formWriteActionResult(
              context,
              writeResult,
              questionInput.field,
              selectedOptions.join('、'),
              required,
            );
            if (writeResult.status === 'verified') {
              return new ActionResult({
                success: true,
                includeInMemory: true,
                extractedContent: JSON.stringify({
                  question: questionInput.question,
                  userResponse: answer,
                  autoFilled: {
                    field: questionInput.field.label,
                    value: writeResult.actualValue || selectedOptions.join('、'),
                    status: 'verified',
                  },
                  instruction:
                    'User selected an exact dropdown option and it has ALREADY been written and verified on the page. Do not write this field again. Continue other remaining fields or call done.',
                }),
              });
            }
          } catch {
            /* Fall back to returning the user's answer for normal agent handling if direct write fails. */
          }
        }
      }
      return new ActionResult({
        success: true,
        includeInMemory: true,
        extractedContent: JSON.stringify({
          question: questionInput.question,
          replacements: questionInput.replacements,
          userResponse: answer,
          instruction:
            answer.decision === 'skip'
              ? questionInput.replacement
                ? 'User confirmed keeping the existing value on the page. Do not ask or overwrite this field again. Continue other fields, or call done(success=true) if no unresolved items remain.'
                : 'Leave this unresolved. Do not ask again this run. Continue other fields.'
              : answer.decision === 'defer'
                ? 'The user will handle this item later (fill it or complete the step on the website). Leave it unchanged; it is recorded as a reminder. Do not ask again this run. Continue every other fillable item, then call done and remind the user in the report.'
                : 'User supplied this answer for this question only. Interpret natural language and convert unambiguous facts into the format required by the website; do not ask the user to reformat them. Clarify if meaning is ambiguous. Observe the current page again before acting.',
        }),
      });
    }, askUserSchema);
  return question;
}
