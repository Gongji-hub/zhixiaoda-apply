import { ActionResult, type AgentContext } from '@src/background/agent/types';
import type { z } from 'zod';
import { URLNotAllowedError } from '../../browser/views';
import type { DecisionClient } from '../../decisionClient';
import { ApplicationDialogPending } from '../applicationDialog';
import { Actors, ExecutionState } from '../event/types';
import { fillApplicationForm } from '../formPlan/fill';
import { Action } from './action';
import { formStructureKey } from './formBatch';
import { clickTextActionSchema, fillApplicationFormActionSchema } from './schemas';
import { formWriteActionResult } from './writeResult';

export function createFormActions(context: AgentContext, extractorLLM: DecisionClient) {

  const clickText = new Action(async (input: z.infer<typeof clickTextActionSchema.schema>) => {
      if (!context.options.targetOrigin)
        return new ActionResult({ error: '按文字点击只用于网申任务。', includeInMemory: true });
      if (input.effect !== 'open_interface' && input.effect !== 'edit_application' && input.effect !== 'advance_form')
        return new ActionResult({
          error:
            'MANUAL_ACTION_REQUIRED: 该点击属于需要用户完成的效果（登录、上传、提交或非勾选形式的协议等），请 ask_user(kind=manual_action)。',
          includeInMemory: true,
        });
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || `点击「${input.text}」`);
      const page = await context.browserContext.getCurrentPage();
      await context.browserContext.assertApplyTarget(page.tabId);
      try {
        const clicked = await page.clickApplicationText(input.text, input.after ?? null, context.controller.signal);
        if (!clicked)
          return new ActionResult({
            error: `没找到可点击的「${input.text}」：文字要与页面完全一致；同名的有多处时用 after 写它前面的区块标题。会离开页面或提交的元素不会点。`,
            includeInMemory: true,
          });
        const msg = `已点击「${input.text}」。请重新观察页面变化。`;
        context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      } catch (error) {
        if (error instanceof URLNotAllowedError) throw error;
        return new ActionResult({
          error: error instanceof Error ? error.message : String(error),
          includeInMemory: true,
        });
      }
    }, clickTextActionSchema);

  let lastFullFill: { url: string; structureKey: string; answersCount: number } | null = null;
  const fullForm = new Action(async () => {
      if (!context.options.targetOrigin)
        return new ActionResult({ error: '整页填写只用于网申任务。', includeInMemory: true });
      const preState = await context.browserContext.getCachedState().catch(() => null);
      const answersCount = context.messageManager.getUserAnswers().length;
      const hasPendingStructuralRetry = context.review
        .snapshot()
        .some(entry => ['DATE_RANGE_INCOMPLETE', 'CLICK_TARGET_OBSCURED'].includes(entry.failureCode ?? ''));
      if (
        preState &&
        lastFullFill &&
        preState.url === lastFullFill.url &&
        answersCount === lastFullFill.answersCount &&
        !hasPendingStructuralRetry &&
        formStructureKey(preState) === lastFullFill.structureKey
      ) {
        return new ActionResult({
          extractedContent:
            '当前页面表单刚刚已完成整页规划与填写，页面字段结构与用户补充回答均无变化，无需重复整页重跑。请直接针对待补充的必填缺失项调用 ask_user（带 index 或 review_key），若无待询问必填项则调用 done。',
          includeInMemory: true,
        });
      }
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, '整页读取并填写表单');
      try {
        const summary = await fillApplicationForm(context, extractorLLM, formWriteActionResult);
        const postState = await context.browserContext.getCachedState().catch(() => null);
        if (postState) {
          lastFullFill = {
            url: postState.url,
            structureKey: formStructureKey(postState),
            answersCount: context.messageManager.getUserAnswers().length,
          };
        }
        if (summary.startsWith('整页填写结束')) {
          context.pendingPostFillFlow = true;
          context.lastFullFillMeta = {
            url: postState?.url ?? preState?.url ?? '',
            hasPreservedConflicts: summary.includes('已有内容与资料不同（未覆盖'),
            hasStructureProblems: summary.includes('区块未补齐（'),
          };
        }
        context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, '整页填写完成');
        return new ActionResult({ extractedContent: summary, includeInMemory: true });
      } catch (error) {
        if (error instanceof URLNotAllowedError) throw error;
        if (error instanceof ApplicationDialogPending) {
          context.completionSuccess = false;
          context.finalAnswer = error.message;
          return new ActionResult({ isDone: true, success: false, extractedContent: error.message, includeInMemory: true });
        }
        const message = `整页填写中断：${error instanceof Error ? error.message : String(error)}。已写入的内容保留，可重新观察后用逐项工具继续。`;
        context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, message);
        return new ActionResult({ error: message, includeInMemory: true });
      }
    }, fillApplicationFormActionSchema);
  return { clickText, fullForm };
}
