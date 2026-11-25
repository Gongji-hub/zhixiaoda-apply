import type { FeedbackIssueReportResult } from '../feedbackOverlay';
import { sendRuntimeMessage } from './controls';
import { type OverlayUI } from './model';
import { applyCardExpansion, syncFeedbackUI } from './updateCard';
import { removeViewportGlow } from './viewportGlow';

export const sendAnswer = (ui: OverlayUI, decision: 'answer' | 'confirm_replace' | 'skip' | 'defer', text = '') => {
  const q = ui.model.current.question;
  if (!q) return;
  ui.view.button.disabled = true;
  ui.view.secondaryBtn.disabled = true;
  void sendRuntimeMessage<{ ok?: boolean }>({
    type: 'application_feedback_answer',
    taskId: ui.model.current.taskId,
    token: ui.model.current.token,
    questionId: q.id,
    decision,
    text,
    ...(q.multiple && decision === 'answer' ? { selectedOptions: [...ui.model.selectedOptions] } : {}),
  }).then(response => {
    if (!response?.ok) {
      ui.view.button.disabled = false;
      ui.view.secondaryBtn.disabled = false;
    }
  });
};

export function bindCardActions(ui: OverlayUI, dismiss: () => void) {
  const {
    copyTrace,
    expandToggle,
    collapseChip,
    reportFeedback,
    feedbackTagButtons,
    feedbackStatus,
    feedbackCopy,
    feedbackCancel,
    feedbackSubmit,
  } = ui.view;
  expandToggle.addEventListener('click', () => {
    ui.model.expandedOverride = true;
    applyCardExpansion(ui, true);
  });
  collapseChip.addEventListener('click', () => {
    ui.model.expandedOverride = false;
    applyCardExpansion(ui, false);
  });
  reportFeedback.addEventListener('click', event => {
    if (!event.isTrusted) return;
    if (ui.model.current.mode !== 'done' && ui.model.current.mode !== 'paused') return;
    const nextOpen = !ui.model.isExpanded || !ui.model.feedbackOpen;
    if (nextOpen && !ui.model.isExpanded) {
      ui.model.expandedOverride = true;
      applyCardExpansion(ui, true);
    }
    ui.model.feedbackOpen = nextOpen;
    syncFeedbackUI(ui);
    if (nextOpen) feedbackSubmit.focus();
  });
  for (const chip of feedbackTagButtons) {
    chip.addEventListener('click', event => {
      if (!event.isTrusted) return;
      const label = chip.textContent || '';
      if (!label) return;
      if (ui.model.feedbackReasons.has(label)) ui.model.feedbackReasons.delete(label);
      else ui.model.feedbackReasons.add(label);
      chip.setAttribute('aria-pressed', String(ui.model.feedbackReasons.has(label)));
    });
  }
  feedbackCancel.addEventListener('click', event => {
    if (!event.isTrusted) return;
    ui.model.feedbackOpen = false;
    syncFeedbackUI(ui);
  });
  feedbackCopy.addEventListener('click', async event => {
    if (!event.isTrusted || !ui.model.lastFeedbackSummary) return;
    feedbackCopy.disabled = true;
    try {
      await navigator.clipboard.writeText(ui.model.lastFeedbackSummary);
      feedbackCopy.textContent = '已复制';
    } catch {
      feedbackCopy.textContent = '复制失败';
    } finally {
      setTimeout(() => {
        feedbackCopy.disabled = false;
        feedbackCopy.textContent = '复制诊断';
      }, 1500);
    }
  });
  const submitFeedback = async () => {
    if (ui.model.feedbackBusy) return;
    if (ui.model.current.mode !== 'done' && ui.model.current.mode !== 'paused') return;
    const { taskId, token } = ui.model.current;
    ui.model.feedbackBusy = true;
    feedbackSubmit.disabled = true;
    feedbackSubmit.textContent = '保存中…';
    feedbackStatus.hidden = true;
    feedbackStatus.classList.remove('error');
    try {
      const response = await sendRuntimeMessage<FeedbackIssueReportResult>({
        type: 'application_feedback_report_issue',
        taskId,
        token,
        reasons: [...ui.model.feedbackReasons],
      });
      if (ui.model.current.token !== token || !ui.view.host.isConnected) return;
      if (response?.ok) {
        ui.model.feedbackSubmitted = true;
        ui.model.lastFeedbackSummary = response.summaryText || '';
        feedbackCopy.hidden = !ui.model.lastFeedbackSummary;
        feedbackStatus.textContent = '已本地保存脱敏诊断，点「复制诊断」即可粘贴到 GitHub Issue';
        feedbackStatus.hidden = false;
        feedbackSubmit.textContent = '重新生成';
        syncFeedbackUI(ui);
      } else {
        feedbackStatus.textContent = response?.error || '诊断保存失败，请重试';
        feedbackStatus.classList.add('error');
        feedbackStatus.hidden = false;
        feedbackSubmit.textContent = '生成诊断';
      }
    } catch {
      feedbackStatus.textContent = '诊断保存失败，请重试';
      feedbackStatus.classList.add('error');
      feedbackStatus.hidden = false;
      feedbackSubmit.textContent = '生成诊断';
    } finally {
      ui.model.feedbackBusy = false;
      feedbackSubmit.disabled = false;
    }
  };
  feedbackSubmit.addEventListener('click', event => {
    if (!event.isTrusted) return;
    void submitFeedback();
  });
  copyTrace.addEventListener('click', async event => {
    if (!event.isTrusted || !ui.model.current.canCopyTrace) return;
    const { taskId, token } = ui.model.current;
    copyTrace.disabled = true;
    try {
      const response = await sendRuntimeMessage<{ ok?: boolean; trace?: string }>({
        type: 'application_feedback_copy_trace',
        taskId,
        token,
      });
      if (ui.model.current.token !== token || !ui.view.host.isConnected) return;
      if (response?.ok && response.trace) {
        await navigator.clipboard.writeText(response.trace);
        copyTrace.textContent = '已复制';
      } else {
        copyTrace.textContent = response?.trace === '' ? '暂无轨迹' : '复制失败';
      }
    } catch {
      copyTrace.textContent = '复制失败';
    } finally {
      setTimeout(() => {
        copyTrace.disabled = false;
        copyTrace.textContent = '复制轨迹';
      }, 1600);
    }
  });

  ui.view.button.addEventListener('click', event => {
    if (!event.isTrusted) return;
    if (ui.model.current.mode === 'done') {
      void sendRuntimeMessage({
        type: 'application_feedback_dismiss',
        taskId: ui.model.current.taskId,
        token: ui.model.current.token,
      });
      ui.view.host.remove();
      removeViewportGlow();
      dismiss();
      document.getElementById('qz-agent-field-focus')?.remove();
      return;
    }
    if (ui.model.current.mode === 'connect') {
      ui.view.button.disabled = true;
      void chrome.runtime
        .sendMessage({
          type: 'application_feedback_open_workbench',
          taskId: ui.model.current.taskId,
          token: ui.model.current.token,
        })
        .finally(() => {
          ui.view.host.remove();
          removeViewportGlow();
          dismiss();
        });
      return;
    }
    if (ui.model.current.mode === 'waiting' && ui.model.current.question) {
      const q = ui.model.current.question;
      if (q.kind === 'manual_action') {
        const termsText = `${q.field?.label || ''} ${q.question}`;
        const isStrictTerms =
          /(隐私政策|隐私条款|隐私声明|隐私保护|同意隐私|个人信息保护|用户协议|服务协议|使用条款|同意协议|申请须知|投递须知|我已阅读|阅读并同意|本人承诺|真实性声明|信息真实|知情同意)/u.test(
            termsText,
          ) &&
          !/(不同意|拒绝|没有|暂无|调剂|服从|分配|背景调查|背调|人才库|推荐其他|消息推送|营销|订阅)/u.test(termsText);
        const boundEl =
          isStrictTerms && q.field
            ? ui.fields.resolveFieldElement({
                key: q.field.key,
                legacyKey: q.field.legacyKey,
                label: q.field.label,
                reason: '',
                kind: 'consent',
                index: q.field.index,
              })
            : null;
        if (boundEl && ui.fields.checkConsentOnPage(boundEl)) {
          sendAnswer(ui, 'answer', '同意');
        } else {
          sendAnswer(ui, 'answer', '我已完成网页操作，请重新观察页面确认是否可以继续。');
        }
      } else if (q.replacement) {
        sendAnswer(ui, 'confirm_replace', '');
      } else {
        const val = q.multiple
          ? [...ui.model.selectedOptions].join('、')
          : ui.view.answerInput.value.trim() || (q.options?.length === 1 ? q.options[0] : '');
        if (!val) {
          ui.view.answerInput.focus();
          return;
        }
        sendAnswer(ui, 'answer', val);
      }
      return;
    }
    if (ui.model.current.mode === 'paused') {
      ui.view.button.disabled = true;
      void chrome.runtime
        .sendMessage({
          type: 'application_feedback_resume',
          taskId: ui.model.current.taskId,
          token: ui.model.current.token,
        })
        .then(response => {
          if (!response?.ok) ui.view.button.disabled = false;
        })
        .catch(() => {
          ui.view.button.disabled = false;
        });
      return;
    }
    ui.view.button.disabled = true;
    void chrome.runtime
      .sendMessage({
        type: 'application_feedback_pause',
        taskId: ui.model.current.taskId,
        token: ui.model.current.token,
      })
      .then(response => {
        if (!response?.ok) ui.view.button.disabled = false;
      })
      .catch(() => {
        ui.view.title.textContent = '连接已断开';
        ui.view.detail.textContent = '请重新点击右上角插件图标继续。';
      });
  });

  ui.view.secondaryBtn.addEventListener('click', event => {
    if (!event.isTrusted) return;
    if (ui.model.current.mode === 'connect') {
      ui.view.host.remove();
      removeViewportGlow();
      dismiss();
      return;
    }
    if (ui.model.current.mode !== 'waiting' || !ui.model.current.question) return;
    const q = ui.model.current.question;
    sendAnswer(ui, q.kind === 'manual_action' ? 'defer' : 'skip', '');
  });

  ui.view.answerInput.addEventListener('keydown', event => {
    if (
      event.key === 'Enter' &&
      !event.isComposing &&
      ui.model.current.mode === 'waiting' &&
      ui.model.current.question
    ) {
      event.preventDefault();
      const val = ui.view.answerInput.value.trim();
      if (val) sendAnswer(ui, 'answer', val);
    }
  });
}
