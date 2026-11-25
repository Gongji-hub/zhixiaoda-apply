import { t } from '@extension/i18n';
import { ActionResult, type AgentContext } from '@src/background/agent/types';
import type { DOMElementNode } from '@src/background/browser/dom/views';
import { createLogger } from '@src/background/log';
import type { z } from 'zod';
import { URLNotAllowedError } from '../../browser/views';
import { containsSanitizationPlaceholder, isSanitizationPlaceholder } from '../../services/guardrails/patterns';
import { hasConfirmedPrivacyConsent } from '../applicationEvidence';
import { Actors, ExecutionState } from '../event/types';
import { formFieldReference } from '../formReview';
import { writeApplicationField } from '../writeApplicationField';
import { Action } from './action';
import { needsUserInteraction } from './interactionPolicy';
import { clickElementActionSchema, inputTextActionSchema } from './schemas';
import { formWriteActionResult, recordFormFailure } from './writeResult';

const logger = createLogger('Action');

/** 链接（含所在的 a 祖先）会把当前标签页带到别的文档，或另开页面。页内锚点不算。 */
function leavesPage(node: DOMElementNode, current: string): boolean {
  let link: DOMElementNode | null = node;
  while (link && !((link.tagName ?? '').toLowerCase() === 'a' && link.attributes.href)) link = link.parent;
  if (!link) return false;
  try {
    const to = new URL(link.attributes.href, current);
    const from = new URL(current);
    return (
      link.attributes.target === '_blank' ||
      to.origin + to.pathname + to.search !== from.origin + from.pathname + from.search
    );
  } catch {
    return false;
  }
}

export function createInputActions(context: AgentContext) {

  const clickElement = new Action(
    async (input: z.infer<typeof clickElementActionSchema.schema>) => {
      const intent = input.intent || t('act_click_start', [input.index.toString()]);
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await context.browserContext.getCurrentPage();
      await context.browserContext.assertApplyTarget(page.tabId);
      const state = context.options.targetOrigin ? page.getCachedState() : await page.getState();

      const elementNode = state?.selectorMap.get(input.index);
      if (!elementNode) {
        throw new Error(t('act_errors_elementNotExist', [input.index.toString()]));
      }
      if (input.effect === 'accept_terms') {
        const field = state ? formFieldReference(state, elementNode, input.index) : null;
        if (
          context.options.targetOrigin &&
          field &&
          context.review.entry(field)?.status !== 'skipped' &&
          !needsUserInteraction(elementNode, 'accept_terms') &&
          hasConfirmedPrivacyConsent(context) &&
          typeof page.clickApplicationToggle === 'function'
        ) {
          const writeResult = await writeApplicationField(context, page, {
            field,
            node: elementNode,
            value: 'true',
            method: 'check',
            policy: 'never',
          });
          const required =
            elementNode.attributes.required !== undefined || elementNode.attributes['aria-required'] === 'true';
          return await formWriteActionResult(context, writeResult, field, 'true', required);
        }
        if (state && field) {
          context.review.recordDeferred(field);
          await context.emitEvent(
            Actors.SYSTEM,
            ExecutionState.REVIEW_UPDATED,
            JSON.stringify(context.review.snapshot()),
          );
        }
        return new ActionResult({
          error:
            'CONSENT_CONFIRMATION_REQUIRED: 不再默认同意协议。请用户确认并在页面勾选，随后重新核对；不要更改 effect 绕过。',
          includeInMemory: true,
        });
      }
      let dialogActionNotFileInput = false;
      if (input.effect === 'upload_file' || page.isFileUploader(elementNode)) {
        if (context.options.resumeFile) {
          const uploaded = await page.uploadApplicationFile(elementNode, context.options.resumeFile);
          if (uploaded.ok) {
            if (state?.url) context.autoUploadedResumeUrls.add(state.url);
            if (uploaded.modalOpened) context.pendingUploadModal = true;
            const fileName = uploaded.fileName || context.options.resumeFile.fileName;
            if (state) {
              const field = formFieldReference(state, elementNode, input.index);
              context.review.recordWrite(
                field,
                fileName,
                {
                  status: 'verified',
                  code: 'UPLOADED',
                  message: `已自动上传简历附件：${fileName}`,
                  adapter: 'file-upload',
                  attempts: 1,
                  actualValue: fileName,
                  desiredValue: fileName,
                },
                false,
              );
              await context.emitEvent(
                Actors.SYSTEM,
                ExecutionState.REVIEW_UPDATED,
                JSON.stringify(context.review.snapshot()),
              );
            }
            const msg = `已自动上传用户的简历文件「${fileName}」。请重新观察页面变化。`;
            context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
            return new ActionResult({ extractedContent: msg, includeInMemory: true });
          }
          if (uploaded.reason === 'DIALOG_ACTION_NOT_FILE_INPUT') {
            dialogActionNotFileInput = true;
          }
        }
        if (state && !dialogActionNotFileInput) {
          context.review.recordDeferred(formFieldReference(state, elementNode, input.index), {
            adapter: 'file-upload',
            failureCode: 'MANUAL_ATTACHMENT',
            message: '附件需由用户本人确认后手动上传。',
          });
          await context.emitEvent(
            Actors.SYSTEM,
            ExecutionState.REVIEW_UPDATED,
            JSON.stringify(context.review.snapshot()),
          );
        }
      }
      const effectiveEffect = dialogActionNotFileInput ? 'open_interface' : input.effect;
      if (needsUserInteraction(elementNode, effectiveEffect)) {
        const toggle =
          elementNode.tagName?.toLowerCase() === 'input' &&
          ['checkbox', 'radio'].includes(elementNode.attributes.type?.toLowerCase() ?? '');
        return new ActionResult({
          error:
            toggle && input.effect !== 'edit_application'
              ? 'MANUAL_ACTION_REQUIRED: 勾选或取消勾选属于填写表单。普通表单选项只有具备用户事实依据时才用 effect=edit_application；资料没有必须 ask_user。协议、授权、隐私声明请用户确认并在页面勾选。'
              : 'MANUAL_ACTION_REQUIRED: 此动作属于需要用户操作的效果或受保护的控件。自定义选项请改用 select_custom_option 绑定所属字段；确实需要用户才能继续时才 ask_user(kind=manual_action)，不要改报 effect 绕过。最终提交不执行，也不要求用户提交来结束本轮。',
          includeInMemory: true,
        });
      }

      if (context.options.targetOrigin && context.review.snapshot().length && leavesPage(elementNode, state!.url))
        return new ActionResult({
          error:
            'LEAVE_PAGE_BLOCKED: 这个链接会离开正在填写的网申页面，已填内容可能丢失，已阻止。继续处理本页剩余字段，本页处理完就调用 done 汇报；确需用户去别的页面才 ask_user(kind=manual_action)。',
          includeInMemory: true,
        });

      // Check if element is a file uploader
      if (page.isFileUploader(elementNode)) {
        const msg = t('act_click_fileUploader', [input.index.toString()]);
        logger.info(msg);
        return new ActionResult({
          extractedContent: msg,
          includeInMemory: true,
        });
      }

      try {
        if (
          context.options.targetOrigin &&
          input.effect === 'edit_application' &&
          ((elementNode.tagName?.toLowerCase() === 'input' &&
            ['checkbox', 'radio'].includes(elementNode.attributes.type?.toLowerCase() ?? '')) ||
            ['checkbox', 'radio', 'switch'].includes(elementNode.attributes.role))
        ) {
          const field = formFieldReference(state!, elementNode, input.index);
          if (context.review.isSkipped(field))
            return new ActionResult({ extractedContent: '用户已跳过此字段，本轮保留现状。', includeInMemory: true });
          const checked =
            elementNode.attributes.checked === 'true' || elementNode.attributes['aria-checked'] === 'true';
          const radio = elementNode.attributes.type === 'radio' || elementNode.attributes.role === 'radio';
          const result = await writeApplicationField(context, page, {
            field,
            node: elementNode,
            value: String(radio || !checked),
            method: 'check',
            policy: 'never',
            observedValue: String(checked),
          });
          return formWriteActionResult(
            context,
            result,
            field,
            '',
            Boolean(elementNode.attributes.required) || elementNode.attributes['aria-required'] === 'true',
          );
        }
        await page.clickElementNode(context.options.useVision, elementNode, context.controller.signal);
        let msg = t('act_click_ok', [input.index.toString(), elementNode.getAllTextTillNextClickableElement(2)]);
        logger.info(msg);

        const currentPage = await context.browserContext.getCurrentPage();
        if (currentPage.tabId !== page.tabId) msg += ' 已切换到此操作打开的新页面，请重新观察后继续。';
        context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      } catch (error) {
        if (error instanceof URLNotAllowedError) throw error;
        const msg = t('act_errors_elementNoLongerAvailable', [input.index.toString()]);
        context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
        return new ActionResult({
          error: error instanceof Error ? error.message : String(error),
          includeInMemory: true,
        });
      }
    },
    clickElementActionSchema,
    true,
  );


  const inputText = new Action(
    async (input: z.infer<typeof inputTextActionSchema.schema>) => {
      const intent = input.intent || t('act_inputText_start', [input.index.toString()]);
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      if (context.options.targetOrigin && containsSanitizationPlaceholder(input.text)) {
        const error =
          '填写值包含内部脱敏占位符，已阻止写入。请从简历原文或用户回答取真实值；没有证据时 ask_user，不能把占位符当成个人事实。';
        context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, error);
        const observed = await context.browserContext.getCachedState();
        const node = observed.selectorMap.get(input.index);
        if (node) recordFormFailure(context, formFieldReference(observed, node, input.index), error);
        return new ActionResult({ error, includeInMemory: true });
      }

      const page = await context.browserContext.getCurrentPage();
      await context.browserContext.assertApplyTarget(page.tabId);
      const state = context.options.targetOrigin ? page.getCachedState() : await page.getState();

      const elementNode = state?.selectorMap.get(input.index);
      if (!elementNode) {
        throw new Error(t('act_errors_elementNotExist', [input.index.toString()]));
      }
      if (needsUserInteraction(elementNode, input.effect, 'input')) {
        return new ActionResult({
          extractedContent:
            '该动作会提交表单或需要用户接手。调用 ask_user(kind=manual_action) 说明当前需要完成的操作；不要反复尝试，也不能改报 effect 绕过。',
          includeInMemory: true,
        });
      }

      const currentValue = elementNode.attributes.value ?? '';
      const repairPlaceholder = context.options.targetOrigin && isSanitizationPlaceholder(currentValue);
      if (!context.options.targetOrigin && currentValue.trim() && !input.replace_existing && !repairPlaceholder) {
        return new ActionResult({
          extractedContent:
            currentValue === input.text
              ? '此字段已有相同内容，保留并继续。'
              : '此字段已有真实内容，与拟填写值不同，未执行覆盖。必须先 ask_user 请用户确认；确认后才可使用 replace_existing=true。不要重复尝试输入。',
          includeInMemory: true,
        });
      }

      try {
        const result = context.options.targetOrigin
          ? await writeApplicationField(context, page, {
              field: formFieldReference(state!, elementNode, input.index),
              node: elementNode,
              value: input.text,
              method: 'type',
              policy: input.replace_existing ? 'approved_grant' : 'never',
              observedValue: currentValue,
              useVision: context.options.useVision,
            })
          : await page.inputTextElementNode(context.options.useVision, elementNode, input.text);
        if (result)
          return formWriteActionResult(
            context,
            result,
            formFieldReference(state!, elementNode, input.index),
            input.text,
            Boolean(elementNode.attributes.required),
          );
      } catch (error) {
        if (error instanceof URLNotAllowedError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (!context.controller.signal.aborted) {
          recordFormFailure(context, formFieldReference(state!, elementNode, input.index), message);
        }
        context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, message);
        return new ActionResult({ error: message, includeInMemory: true });
      }
      const msg = t('act_inputText_ok', [input.text, input.index.toString()]);
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    },
    inputTextActionSchema,
    true,
  );

  return { clickElement, inputText };
}
