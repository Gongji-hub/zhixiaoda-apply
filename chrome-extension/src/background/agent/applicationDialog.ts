import type { DOMElementNode } from '../browser/dom/views';
import { Actors, ExecutionState } from './event/types';
import type { AgentContext } from './types';
import { UserQuestionWithdrawn } from './userInput';

export class ApplicationDialogPending extends Error {
  constructor() {
    super('网页弹窗还开着，已保留填写进度。请先处理弹窗再继续。');
    this.name = 'ApplicationDialogPending';
  }
}

/** Wait for permission to start the next form operation. */
export async function waitForApplicationResume(context: AgentContext): Promise<void> {
  while (context.paused && !context.stopped && !context.controller.signal.aborted)
    await new Promise(resolve => setTimeout(resolve, 100));
  if (context.stopped || context.controller.signal.aborted) throw new Error('操作已停止。');
}

/** A blocking dialog belongs to this step. Do not read or operate the form behind it. */
export async function waitForApplicationDialog(context: AgentContext, draftRemoval?: DOMElementNode): Promise<boolean> {
  if (!context.options?.targetOrigin) return false;
  const page = await context.browserContext.getCurrentPage();
  if (typeof page.readApplicationDialog !== 'function') return false;
  const signal = context.controller.signal;
  let state: Awaited<ReturnType<typeof page.readApplicationDialog>> = 'clear';
  // A newly opened modal can appear after the click returns (including CSS enter transitions).
  for (let poll = 0; poll < (draftRemoval ? 6 : 1); poll++) {
    await waitForApplicationResume(context);
    state = await page.readApplicationDialog(Boolean(draftRemoval) && !context.paused, draftRemoval);
    if (state !== 'clear') break;
    if (draftRemoval && poll < 5) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (state === 'clear') return false;
  if (state === 'confirmed') {
    context.trace?.('网页弹窗', 0, '已确认撤回插件刚添加的临时行');
    for (let poll = 0; poll < 10; poll++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      signal.throwIfAborted();
      if (await page.readApplicationDialog() === 'clear') return true;
    }
  }

  await waitForApplicationPopup(context, async () => await page.readApplicationDialog() === 'clear',
    '请先处理网页上的弹窗，关掉后继续填写。');
  return true;
}

/** Wait only for a blocking site dialog; ordinary field failures stay in the control fallback. */
export async function waitForApplicationPopup(context: AgentContext, closed: () => Promise<boolean>, question: string) {
  const signal = context.controller.signal;
  for (;;) {
    // Upload progress and closing animations often disappear without user action.
    for (let poll = 0; poll < 4; poll++) {
      await waitForApplicationResume(context);
      if (await closed()) {
        await waitForApplicationResume(context);
        return;
      }
      if (poll < 3) await new Promise(resolve => setTimeout(resolve, 250));
    }
    context.trace?.('网页弹窗', 0, '等待处理弹窗，暂缓填写和核查');
    let questionId = '';
    let published = false;
    let settled = false;
    const pending = context.userInput.ask({
      kind: 'manual_action',
      blockingDialog: true,
      question,
      reason: '弹窗遮挡了当前表单。',
      options: [],
    }, signal, async prompt => {
      questionId = prompt.id;
      await context.emitEvent(Actors.SYSTEM, ExecutionState.USER_QUESTION, JSON.stringify(prompt));
      published = true;
    }).then(answer => {
      settled = true;
      return { answer };
    }, error => {
      settled = true;
      return { error };
    });
    try {
      let clearReads = 0;
      let readFailed = false;
      while (!settled) {
        await Promise.race([pending, new Promise(resolve => setTimeout(resolve, 250))]);
        if (settled) break;
        signal.throwIfAborted();
        if (context.stopped) throw new Error('操作已停止。');
        if (!published || context.paused) { clearReads = 0; continue; }
        let ready = false;
        try {
          ready = await closed();
        } catch {
          // An unreadable page is not evidence that the blocker has gone away.
          if (!readFailed) context.trace?.('网页弹窗', 0, '暂时无法读取弹窗状态，继续等待');
          readFailed = true;
        }
        if (settled) break;
        signal.throwIfAborted();
        if (context.stopped) throw new Error('操作已停止。');
        if (context.paused) { clearReads = 0; continue; }
        clearReads = ready ? clearReads + 1 : 0;
        if (clearReads >= 2) context.userInput.withdraw(questionId);
      }
      const outcome = await pending;
      if ('error' in outcome) {
        if (!(outcome.error instanceof UserQuestionWithdrawn)) throw outcome.error;
        context.trace?.('网页弹窗', 0, '已确认弹窗关闭，自动继续');
        await context.emitEvent(Actors.SYSTEM, ExecutionState.USER_QUESTION_DISMISSED, JSON.stringify({ questionId }));
        await waitForApplicationResume(context);
        return;
      }
      if (outcome.answer.decision === 'defer' || outcome.answer.decision === 'skip') throw new ApplicationDialogPending();
    } finally {
      // A cancelled run cannot leave a question or observer attached to the next run.
      context.userInput.withdraw(questionId);
    }
  }
}
