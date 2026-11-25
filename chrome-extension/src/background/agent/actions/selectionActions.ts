import { t } from '@extension/i18n';
import { ActionResult, type AgentContext } from '@src/background/agent/types';
import { createLogger } from '@src/background/log';
import type { z } from 'zod';
import { URLNotAllowedError } from '../../browser/views';
import type { DecisionClient } from '../../decisionClient';
import { Actors, ExecutionState } from '../event/types';
import { optionResolver } from '../formPlan/optionResolver';
import { formFieldReference } from '../formReview';
import { wrapUntrustedContent } from '../messages/utils';
import { writeApplicationField } from '../writeApplicationField';
import { Action } from './action';
import {
    type ActionSchema,
    getDropdownOptionsActionSchema,
    pickDateActionSchema,
    selectCustomOptionActionSchema,
    selectDropdownOptionActionSchema,
    selectMultipleOptionsActionSchema,
} from './schemas';
import { formWriteActionResult, recordFormFailure } from './writeResult';

const logger = createLogger('Action');

export function createSelectionActions(context: AgentContext, extractorLLM: DecisionClient) {

  const getDropdownOptions = new Action(
    async (input: z.infer<typeof getDropdownOptionsActionSchema.schema>) => {
      const intent = input.intent || t('act_getDropdownOptions_start', [input.index.toString()]);
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await context.browserContext.getCurrentPage();
      const state = context.options.targetOrigin ? page.getCachedState() : await page.getState();

      const elementNode = state?.selectorMap.get(input.index);
      if (!elementNode) {
        const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
        context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
        return new ActionResult({
          error: errorMsg,
          includeInMemory: true,
        });
      }

      try {
        if (context.options.targetOrigin && elementNode.tagName?.toLowerCase() !== 'select') {
          const choices = await context.controlExploration.run(formFieldReference(state!, elementNode, input.index),
            context.controller.signal, signal => page.listCustomOptions(elementNode, signal));
          return new ActionResult({
            extractedContent: choices.length
              ? `${wrapUntrustedContent(JSON.stringify({ dropdown_options: choices }), true, true)}\n用 select_custom_option(index=${input.index}, text=其中一个精确文本) 选择；没有合适项就按简历判断或 ask_user。`
              : '展开后没有出现选项。',
            includeInMemory: true,
          });
        }
        // Use the existing getDropdownOptions method
        const options = await page.getDropdownOptions(input.index);

        if (options && options.length > 0) {
          // Format options for display
          const formattedOptions: string[] = options.map(opt => {
            // Encoding ensures AI uses the exact string in select_dropdown_option
            const encodedText = JSON.stringify(opt.text);
            return `${opt.index}: text=${encodedText}`;
          });

          let msg = formattedOptions.join('\n');
          msg += '\n' + t('act_getDropdownOptions_useExactText');
          context.emitEvent(
            Actors.NAVIGATOR,
            ExecutionState.ACT_OK,
            t('act_getDropdownOptions_ok', [options.length.toString()]),
          );
          return new ActionResult({
            extractedContent: msg,
            includeInMemory: true,
          });
        }

        // This code should not be reached as getDropdownOptions throws an error when no options found
        // But keeping as fallback
        const msg = t('act_getDropdownOptions_noOptions');
        context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({
          extractedContent: msg,
          includeInMemory: true,
        });
      } catch (error) {
        const errorMsg = t('act_getDropdownOptions_failed', [error instanceof Error ? error.message : String(error)]);
        context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
        return new ActionResult({
          error: errorMsg,
          includeInMemory: true,
        });
      }
    },
    getDropdownOptionsActionSchema,
    true,
  );


  // Select dropdown option for interactive element index by the text of the option you want to select'
  const selectDropdownOption = new Action(
    async (input: z.infer<typeof selectDropdownOptionActionSchema.schema>) => {
      const intent = input.intent || t('act_selectDropdownOption_start', [input.text, input.index.toString()]);
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await context.browserContext.getCurrentPage();
      const state = context.options.targetOrigin ? page.getCachedState() : await page.getState();

      const elementNode = state?.selectorMap.get(input.index);
      if (!elementNode) {
        const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
        context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
        return new ActionResult({
          error: errorMsg,
          includeInMemory: true,
        });
      }

      // Validate that we're working with a select element
      if (!elementNode.tagName || elementNode.tagName.toLowerCase() !== 'select') {
        const errorMsg = t('act_selectDropdownOption_notSelect', [
          input.index.toString(),
          elementNode.tagName || 'unknown',
        ]);
        context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
        return new ActionResult({
          error: errorMsg,
          includeInMemory: true,
        });
      }

      logger.debug(`Attempting to select '${input.text}' using xpath: ${elementNode.xpath}`);

      try {
        const field = formFieldReference(state!, elementNode, input.index);
        const result = context.options.targetOrigin
          ? await writeApplicationField(context, page, {
              field,
              node: elementNode,
              value: input.text,
              method: 'choose',
              policy: input.replace_existing ? 'approved_grant' : 'never',
              resolveOption: optionResolver(context, extractorLLM, field.label),
            })
          : await page.selectDropdownOption(input.index, input.text);
        if (typeof result !== 'string')
          return formWriteActionResult(
            context,
            result,
            formFieldReference(state!, elementNode, input.index),
            input.text,
            Boolean(elementNode.attributes.required),
          );
        const msg = t('act_selectDropdownOption_ok', [input.text, input.index.toString()]);
        context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({
          extractedContent: result,
          includeInMemory: true,
        });
      } catch (error) {
        const errorMsg = t('act_selectDropdownOption_failed', [error instanceof Error ? error.message : String(error)]);
        context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
        return new ActionResult({
          error: errorMsg,
          includeInMemory: true,
        });
      }
    },
    selectDropdownOptionActionSchema,
    true,
  );


  const customOption = new Action(
      async (input: z.infer<typeof selectCustomOptionActionSchema.schema>) => {
        const page = await context.browserContext.getCurrentPage();
        const state = page.getCachedState();
        const node = state?.selectorMap.get(input.index);
        if (!node) return new ActionResult({ error: '字段索引无效，请重新观察。', includeInMemory: true });
        const field = formFieldReference(state!, node, input.index);
        try {
          const result = await writeApplicationField(context, page, {
            node,
            field,
            value: input.text,
            method: 'choose',
            policy: input.replace_existing ? 'approved_grant' : 'never',
            resolveOption:
              typeof extractorLLM?.decide === 'function'
                ? optionResolver(context, extractorLLM, field.label)
                : undefined,
          });
          return formWriteActionResult(
            context,
            result,
            field,
            input.text,
            node.attributes.required !== undefined || node.attributes['aria-required'] === 'true',
          );
        } catch (error) {
          if (error instanceof URLNotAllowedError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          recordFormFailure(context, field, message);
          return new ActionResult({ error: message, includeInMemory: true });
        }
      },
      selectCustomOptionActionSchema,
      true,
    );

  const fieldWrite = (
    schema: ActionSchema,
    expected: (input: Record<string, unknown>) => string,
    method: 'date' | 'choose_many',
  ) =>
    new Action(
      async (input: Record<string, unknown> & { index: number; replace_existing?: boolean }) => {
        const page = await context.browserContext.getCurrentPage();
        const state = page.getCachedState();
        const node = state?.selectorMap.get(input.index);
        if (!node) return new ActionResult({ error: '字段索引无效，请重新观察。', includeInMemory: true });
        const field = formFieldReference(state!, node, input.index);
        if (context.review.isSkipped(field))
          return new ActionResult({ extractedContent: '用户已明确跳过此字段，本轮保留现状。', includeInMemory: true });
        try {
          return formWriteActionResult(
            context,
            await writeApplicationField(context, page, {
              field,
              node,
              value: expected(input),
              method,
              items: input.texts as string[] | undefined,
              policy: input.replace_existing ? 'approved_grant' : 'never',
              resolveOption:
                typeof extractorLLM?.decide === 'function'
                  ? optionResolver(context, extractorLLM, field.label)
                  : undefined,
            }),
            field,
            expected(input),
            node.attributes.required !== undefined || node.attributes['aria-required'] === 'true',
          );
        } catch (error) {
          if (error instanceof URLNotAllowedError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          recordFormFailure(context, field, message);
          return new ActionResult({ error: message, includeInMemory: true });
        }
      },
      schema,
      true,
    );

  const pickDate = fieldWrite(pickDateActionSchema, input => String(input.value), 'date');
  const multiSelect = fieldWrite(selectMultipleOptionsActionSchema, input => (input.texts as string[]).join('、'), 'choose_many');
  return { getDropdownOptions, selectDropdownOption, customOption, pickDate, multiSelect };
}
