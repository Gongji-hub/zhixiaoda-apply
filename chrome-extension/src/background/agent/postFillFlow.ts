import { auditCompletedForm } from './independentFormAudit';
import { AUDIT_FINDING, isIncompleteAudit } from '../auditStatus';
import { URLNotAllowedError, type BrowserState } from '../browser/views';
import type { DecisionClient } from '../decisionClient';
import { ApplicationDialogPending, waitForApplicationDialog } from './applicationDialog';
import { confirmReplacements } from './confirmReplacements';
import { fieldKind } from './formPlan/outline';
import { handleMissingAnswers } from './missingAnswers';
import { findLiveControlNode, isAbortStopError } from './postFillChecks';
import { reviewApplicationPage } from './reviewPage';
import { ActionResult, type AgentContext } from './types';

const FINAL_SUBMIT_RE = /提交|投递|发送|submit|apply/i;
const ADVANCE_STEP_RE =
  /^(?:(?:下一步|下一页|下一项|继续|继续填写|保存并下一步|保存并继续)(?:[：:\s>»→].*)?|(?:next|next\s*step|next\s*page|save\s*(?:&|and)\s*continue|continue))$/iu;

export interface PostFillFlowOutcome {
  finished: boolean;
  verified: boolean;
}

function hasFormAdvanceButton(state: BrowserState): boolean {
  for (const node of state.selectorMap.values()) {
    if (!node.isVisible || fieldKind(node)) continue;
    if (node.attributes.disabled !== undefined || node.attributes['aria-disabled'] === 'true') continue;
    const label = (
      node.getAllTextTillNextClickableElement(2) ||
      node.attributes['aria-label'] ||
      node.attributes.value ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (!label || FINAL_SUBMIT_RE.test(label)) continue;
    if (ADVANCE_STEP_RE.test(label)) return true;
  }
  return false;
}
export async function runPostFillDirectFlow(
  context: AgentContext,
  extractorLLM: DecisionClient,
): Promise<PostFillFlowOutcome> {
  if (!context.options.targetOrigin || context.stopped || context.paused) {
    return { finished: false, verified: false };
  }

  const handledNotes: string[] = [];
  try {
    if (await waitForApplicationDialog(context)) context.pendingUploadModal = false;
    const obscuredByOverlay =
      (await handleMissingAnswers(context, extractorLLM, handledNotes)) ||
      (await confirmReplacements(context, extractorLLM, handledNotes));
    if (handledNotes.length > 0) {
      context.actionResults = [
        ...context.actionResults,
        new ActionResult({
          extractedContent: `已直接向用户确认并处理：${handledNotes.join('；')}。`,
          includeInMemory: true,
        }),
      ];
    }

    if (obscuredByOverlay) {
      context.actionResults = [
        ...context.actionResults,
        new ActionResult({
          extractedContent: `直连回填被页面顶层弹窗遮挡（${obscuredByOverlay}）。用户已提供的回答已保存在会话上下文中，请先处理当前遮挡弹窗（若表单已有填写内容而弹出简历解析覆盖确认框，请点击“否，仅上传附件 / 不解析”保留已填信息；若涉及志愿或身份决策则调用 ask_user(kind=manual_action)），解除遮挡后补填未落盘字段。`,
          includeInMemory: true,
        }),
      ];
      context.trace?.('整页后检查', 0, '回填被顶层弹窗遮挡，交由导航先处理弹窗');
      return { finished: false, verified: false };
    }

    if (context.stopped || context.paused) {
      return { finished: false, verified: false };
    }

    const consumePendingUploadModal = () => {
      if (!context.pendingUploadModal) return false;
      context.pendingUploadModal = false;
      context.actionResults = [
        ...context.actionResults,
        new ActionResult({
          extractedContent:
            '已自动挂载简历附件，页面随即弹出了确认浮层。请先观察该浮层：表单各字段已填写，若浮层询问是否解析简历覆盖/替换已填写的信息，请点击“否，仅上传附件 / 不解析”（effect="open_interface"）保留已填内容，切勿覆盖已填表单，处理完浮层后调用 done。',
          includeInMemory: true,
        }),
      ];
      context.trace?.('整页后检查', 0, '简历上传后出现确认弹窗，交由导航处理');
      return true;
    };

    if (consumePendingUploadModal()) {
      return { finished: false, verified: false };
    }

    const finalState = await context.browserContext.getState();
    if (hasFormAdvanceButton(finalState)) {
      context.trace?.('整页后检查', 0, '检测到下一步/继续填写入口，交由导航推进');
      return { finished: false, verified: false };
    }

    let unresolved = await reviewApplicationPage(context);
    if (await waitForApplicationDialog(context)) context.pendingUploadModal = false;
    if (consumePendingUploadModal()) {
      return { finished: false, verified: false };
    }
    await auditCompletedForm(context, extractorLLM);
    unresolved = unresolved.filter(entry => entry.failureCode !== AUDIT_FINDING && !isIncompleteAudit(entry));
    const auditEntries = context.review.snapshot().filter(entry => entry.status === 'failed');
    const auditIncomplete = auditEntries.some(isIncompleteAudit);
    const auditProblems = auditEntries.filter(entry => entry.failureCode === AUDIT_FINDING && !isIncompleteAudit(entry));
    unresolved.push(...auditProblems.filter(entry => !unresolved.some(item => item.key === entry.key)));
    const hasUnlocatedMissing = context.review
      .snapshot()
      .some(
        entry =>
          entry.url === finalState.url &&
          !context.review.isSkipped(entry) &&
          !entry.autoDeferred &&
          ['MISSING_INFORMATION', 'DATE_PRECISION_REQUIRED'].includes(entry.failureCode ?? '') &&
          ['pending', 'failed'].includes(entry.status) &&
          !findLiveControlNode(finalState, entry),
      );
    if (hasUnlocatedMissing) {
      return { finished: false, verified: false };
    }

    const meta = context.lastFullFillMeta;
    const hasStructureProblems = Boolean(meta && meta.url === finalState.url && meta.hasStructureProblems);

    if (unresolved.length === 0 && !hasStructureProblems && !auditIncomplete) {
      context.completionSuccess = true;
      context.finalAnswer = '当前页面表单已填写并核对完成，请检查后自行提交。';
      context.trace?.('本轮结束', 0, '整页填写与补充问答已通过核对，无需额外导航模型调用。');
      return { finished: true, verified: true };
    }

    const entries = context.review.snapshot();
    const filledCount = entries.filter(
      entry =>
        ['filled', 'preserved'].includes(entry.status) ||
        (entry.status === 'skipped' && entry.actualValue.trim() !== '' && entry.actualValue !== 'false'),
    ).length;
    context.completionSuccess = false;
    const reviewSummary =
      unresolved.length > 0
        ? `本轮已处理 ${filledCount} 项，剩余 ${unresolved.length} 项待处理，请查看清单提醒。申请尚未提交。`
        : hasStructureProblems
          ? `本轮已处理 ${filledCount} 项，部分区块仍需在页面核对补充。申请尚未提交。`
          : `本轮已处理 ${filledCount} 项。申请尚未提交。`;
    context.finalAnswer = auditIncomplete ? `${reviewSummary}整表核查未完成，可重新核查。` : reviewSummary;
    context.trace?.('本轮结束', 0, auditIncomplete ? '整页填写已结束，独立核查未完成。' : '整页填写与核对已结束，待处理内容见清单。');
    return { finished: true, verified: false };
  } catch (error) {
    if (error instanceof URLNotAllowedError) throw error;
    if (error instanceof ApplicationDialogPending) {
      context.completionSuccess = false;
      context.finalAnswer = error.message;
      return { finished: true, verified: false };
    }
    if (isAbortStopError(context, error)) {
      return { finished: false, verified: false };
    }
    loggerFallback(context, error);
    return { finished: false, verified: false };
  }
}

function loggerFallback(context: AgentContext, error: unknown): void {
  context.trace?.('整页后处理异常', 0, error instanceof Error ? error.message : String(error));
}
