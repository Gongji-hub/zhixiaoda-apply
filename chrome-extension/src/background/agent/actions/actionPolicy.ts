import { ActionResult, type AgentContext } from '@src/background/agent/types';
import { formValuesEquivalent } from '../../browser/formFill';
import { Actors, ExecutionState } from '../event/types';
import { formFieldReference } from '../formReview';
import { wrapUntrustedContent } from '../messages/utils';
import { reviewApplicationPage } from '../reviewPage';
import { Action, InvalidInputError } from './action';
import { formStructureKey } from './formBatch';
import { SELF_CORRECT } from './writeResult';

async function assertApplyTab(context: AgentContext, tabId: number): Promise<void> {
  await context.browserContext.assertApplyTarget(tabId);
}

export function applyActionPolicy(context: AgentContext, actions: Action[]) {
  return actions.map(
    action =>
      new Action(
        async input => {
          if (context.stopped || context.controller.signal.aborted) throw new InvalidInputError('操作已停止');
          while (context.paused && !context.stopped) await new Promise(resolve => setTimeout(resolve, 150));
          if (context.stopped) throw new InvalidInputError('操作已停止');
          const page = await context.browserContext.getCurrentPage();
          await assertApplyTab(context, page.tabId);
          if (action.hasIndex && !page.getCachedState()) {
            throw new InvalidInputError('目标已切换到新页面，请重新观察后再使用元素索引。');
          }
          if (
            context.options.targetOrigin &&
            action.hasIndex &&
            ([
              'input_text',
              'select_dropdown_option',
              'select_custom_option',
              'pick_date',
              'select_multiple_options',
            ].includes(action.name()) ||
              (action.name() === 'click_element' && input.effect === 'edit_application'))
          ) {
            const state = page.getCachedState();
            const node = state?.selectorMap.get(input.index);
            if (node && context.review.isSkipped(formFieldReference(state!, node, input.index)))
              return new ActionResult({
                extractedContent: '用户已明确跳过此字段，本轮保留现状，不再填写。',
                includeInMemory: true,
              });
            if (node) {
              const field = formFieldReference(state!, node, input.index);
              if (context.review.isAutoDeferred(field)) {
                const live = await page.readApplicationControl(node, context.review.chosen(field));
                context.review.reconcile(
                  field,
                  live,
                  live.required ??
                    (node.attributes.required !== undefined || node.attributes['aria-required'] === 'true'),
                );
                if (context.review.isAutoDeferred(field)) {
                  const message = `REPEATED_WRITE_BLOCKED: 此字段已暂缓。${SELF_CORRECT}`;
                  void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, message);
                  return new ActionResult({
                    error: message,
                    includeInMemory: true,
                  });
                }
                void context.emitEvent(
                  Actors.SYSTEM,
                  ExecutionState.REVIEW_UPDATED,
                  JSON.stringify(context.review.snapshot()),
                );
              }
              const toggle =
                action.name() === 'click_element' &&
                ((node.tagName?.toLowerCase() === 'input' &&
                  ['checkbox', 'radio'].includes(node.attributes.type?.toLowerCase() ?? '')) ||
                  ['checkbox', 'radio', 'switch'].includes(node.attributes.role));
              const checked = node.attributes.checked === 'true' || node.attributes['aria-checked'] === 'true';
              const radio = node.attributes.type?.toLowerCase() === 'radio' || node.attributes.role === 'radio';
              const desired = toggle
                ? radio
                  ? 'true'
                  : String(!checked)
                : action.name() === 'pick_date'
                  ? input.value
                  : action.name() === 'select_multiple_options'
                    ? (input.texts as string[]).join('、')
                    : input.text;
              const live = ['select_custom_option', 'pick_date', 'select_multiple_options'].includes(action.name())
                ? await page.readApplicationControl(node)
                : null;
              const actual = live ? live.value : toggle ? String(checked) : (node.attributes.value ?? '');
              // Fresh committed state supersedes an earlier failed write, even if its text is unchanged.
              if (live?.valid && live.selectionConfirmed !== false && formValuesEquivalent(live.value, desired))
                context.formRetries.clearResolved(formFieldReference(state!, node, input.index).key);
              if (
                context.formRetries.blocked(
                  formFieldReference(state!, node, input.index).key,
                  desired,
                  actual,
                  formStructureKey(state!),
                )
              ) {
                const message = `REPEATED_WRITE_BLOCKED: 此字段用同一个值写入已失败过，页面和值都没有变化，重复只会再失败。${SELF_CORRECT}`;
                void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, message);
                return new ActionResult({ error: message, includeInMemory: true });
              }
            }
          }
          if (
            context.options.targetOrigin &&
            input.effect === 'advance_form' &&
            ['click_element', 'click_text'].includes(action.name())
          ) {
            const original = page.getCachedState()?.selectorMap.get(input.index);
            await reviewApplicationPage(context, { readOnly: true });
            const current = page.getCachedState();
            const pending = context.review
              .snapshot()
              .filter(
                entry =>
                  entry.url === current?.url && entry.required && !['filled', 'preserved'].includes(entry.status),
              );
            if (pending.length)
              return new ActionResult({
                error: `FORM_PREREQUISITES_PENDING: 当前表单仍有 ${pending.length} 项必填内容未完成，已阻止保存或进入下一步。继续填写其他独立字段；缺资料的项必须 ask_user，用户跳过或稍后处理后才以部分完成结束。技术失败项保留侧栏提醒，不要重复保存。${wrapUntrustedContent(JSON.stringify(pending.map(({ label, message }) => ({ label, message }))), true, true)}`,
                includeInMemory: true,
              });
            if (original && current?.selectorMap.get(input.index)?.xpath !== original.xpath)
              return new ActionResult({
                error: 'STALE_CONTROL: 核对表单后按钮位置已变化，请重新观察。',
                includeInMemory: true,
              });
          }
          const result = await action.call(input);
          if (context.controller.signal.aborted) {
            return new ActionResult({ error: 'CANCELLED: 操作已取消。' });
          }
          // 只有绑定真实表单字段的写入错误可以局部暂缓；导航、连接和安全错误仍由执行器处理。
          if (
            result.error &&
            context.options.targetOrigin &&
            [
              'input_text',
              'select_dropdown_option',
              'select_custom_option',
              'pick_date',
              'select_multiple_options',
            ].includes(action.name())
          ) {
            const state = page.getCachedState();
            const node = state?.selectorMap.get(input.index);
            if (node) {
              const field = formFieldReference(state!, node, input.index);
              if (
                !context.review.isAutoDeferred(field) &&
                !['MISSING_INFORMATION', 'DATE_PRECISION_REQUIRED'].includes(
                  context.review.snapshot().find(entry => entry.key === field.key)?.failureCode ?? '',
                )
              ) {
                context.review.recordFailure(
                  field,
                  result.error,
                  node.attributes.required !== undefined || node.attributes['aria-required'] === 'true',
                );
                context.review.deferFailure(field);
              }
              result.fieldFailure = true;
              const missingInformation = ['MISSING_INFORMATION', 'DATE_PRECISION_REQUIRED'].includes(
                context.review.snapshot().find(entry => entry.key === field.key)?.failureCode ?? '',
              );
              if (!missingInformation) result.error += ` ${SELF_CORRECT}`;
              await context.emitEvent(
                Actors.SYSTEM,
                ExecutionState.REVIEW_UPDATED,
                JSON.stringify(context.review.snapshot()),
              );
            }
          }
          return result;
        },
        action.schema,
        action.hasIndex,
      ),
  );
}
