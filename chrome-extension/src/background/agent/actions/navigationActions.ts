import { auditCompletedForm } from '../independentFormAudit';
import { AUDIT_FINDING, isIncompleteAudit } from '../../auditStatus';
import type { DecisionClient } from '../../decisionClient';
import { t } from '@extension/i18n';
import { ActionResult, type AgentContext } from '@src/background/agent/types';
import { createLogger } from '@src/background/log';
import type { z } from 'zod';
import { Actors, ExecutionState } from '../event/types';
import { wrapUntrustedContent } from '../messages/utils';
import { reviewApplicationPage } from '../reviewPage';
import { Action } from './action';
import { doneActionSchema, scrollToPercentActionSchema, waitActionSchema } from './schemas';

const logger = createLogger('Action');

export function createNavigationActions(context: AgentContext, llm: DecisionClient) {

  const done = new Action(async (input: z.infer<typeof doneActionSchema.schema>) => {
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, doneActionSchema.name);
    let unresolved = await reviewApplicationPage(context);
    if (context.pendingUploadModal) {
      context.pendingUploadModal = false;
      return new ActionResult({
        error:
          'UPLOAD_MODAL_PENDING: 刚自动挂载了简历附件并弹出了确认浮层。请先观察该浮层：表单各字段已填写，若浮层询问是否解析简历覆盖/替换已填写的信息，请点击“否，仅上传附件 / 不解析”（effect="open_interface"）保留已填内容，处理完浮层后再调用 done。',
        includeInMemory: true,
      });
    }
    await auditCompletedForm(context, llm);
    unresolved = unresolved.filter(entry => entry.failureCode !== AUDIT_FINDING && !isIncompleteAudit(entry));
    const review = context.review.snapshot();
    const auditIncomplete = review.some(entry => entry.status === 'failed' && isIncompleteAudit(entry));
    unresolved.push(...review.filter(entry => entry.status === 'failed' && entry.failureCode === AUDIT_FINDING && !isIncompleteAudit(entry) && !unresolved.some(item => item.key === entry.key)));
    const missing = context.review
      .snapshot()
      .filter(
        entry =>
          ['MISSING_INFORMATION', 'DATE_PRECISION_REQUIRED'].includes(entry.failureCode ?? '') &&
          ['pending', 'failed'].includes(entry.status),
      );
    if (missing.length)
      return new ActionResult({
        error: `USER_INFORMATION_REQUIRED: 还有资料缺失项尚未向用户询问。先完成其他有依据的字段，再逐项 ask_user(index 或 review_key)，不能猜测或直接结束。${wrapUntrustedContent(JSON.stringify(missing.map(({ key, index, label, message }) => ({ review_key: key, index, label, message }))), true, true)}`,
        includeInMemory: true,
      });
    if (unresolved.length && unresolved.every(entry => entry.autoDeferred)) {
      const entries = context.review.snapshot();
      return new ActionResult({
        isDone: true,
        success: false,
        extractedContent: `本轮已处理 ${entries.filter(entry => ['filled', 'preserved'].includes(entry.status)).length} 项，剩余 ${unresolved.length} 项待处理，请查看侧栏提醒。申请尚未提交。${auditIncomplete ? '整表核查未完成，可重新核查。' : ''}`,
      });
    }
    if (input.success && unresolved.length) {
      return new ActionResult({
        error: `FINAL_REVIEW_INCOMPLETE: ${wrapUntrustedContent(JSON.stringify(unresolved.map(({ key, label, message, index, url }) => ({ key, label, message, index, url }))), true, true)}。逐项重新观察，结合网页提示和简历原文自行判断原因并修复；自己确实无法解决的才 ask_user(index=当前字段) 请求用户处理或明确跳过；早前页面的核对项用 review_key 绑定。不得宣称完成。`,
        includeInMemory: true,
      });
    }
    if (auditIncomplete) {
      return new ActionResult({
        isDone: true, success: false, extractedContent: '整表核查未完成，可重新核查。申请尚未提交。',
      });
    }
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, input.text);
    return new ActionResult({
      isDone: true,
      success: input.success,
      extractedContent: input.text,
    });
  }, doneActionSchema);


  const wait = new Action(async (input: z.infer<typeof waitActionSchema.schema>) => {
    const seconds = input.seconds || 3;
    const intent = input.intent || t('act_wait_start', [seconds.toString()]);
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    const msg = t('act_wait_ok', [seconds.toString()]);
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
    return new ActionResult({ extractedContent: msg, includeInMemory: true });
  }, waitActionSchema);


  const scrollToPercent = new Action(async (input: z.infer<typeof scrollToPercentActionSchema.schema>) => {
    const intent = input.intent || t('act_scrollToPercent_start');
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
    const page = await context.browserContext.getCurrentPage();

    if (input.index) {
      const state = await page.getCachedState();
      const elementNode = state?.selectorMap.get(input.index);
      if (!elementNode) {
        const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
        context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
        return new ActionResult({ error: errorMsg, includeInMemory: true });
      }
      logger.info(`Scrolling to percent: ${input.yPercent} with elementNode: ${elementNode.xpath}`);
      await page.scrollToPercent(input.yPercent, elementNode);
    } else {
      await page.scrollToPercent(input.yPercent);
    }
    const msg = t('act_scrollToPercent_ok', [input.yPercent.toString()]);
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
    return new ActionResult({ extractedContent: msg, includeInMemory: true });
  }, scrollToPercentActionSchema);

  return { done, wait, scrollToPercent };
}
