import type { FeedbackState } from '../feedbackOverlay';
import { feedbackReviewCounts } from '../feedbackSummary';
import { sendAnswer } from './cardActions';
import { positionFeedbackCard } from './cardLayout';
import { isPureReadOnlyDisplay } from './controls';
import { type OverlayUI } from './model';
import { renderUnfilledList } from './reviewList';
import { syncViewportGlow } from './viewportGlow';

export const syncFeedbackUI = (ui: OverlayUI) => {
  const canReport = ui.model.current.mode === 'done' || ui.model.current.mode === 'paused';
  if (!canReport) ui.model.feedbackOpen = false;
  ui.view.reportFeedback.hidden = !canReport;
  ui.view.reportFeedback.textContent = ui.model.feedbackSubmitted ? '已反馈' : '反馈';
  ui.view.reportFeedback.classList.toggle('submitted', ui.model.feedbackSubmitted);
  ui.view.reportFeedback.setAttribute('aria-expanded', String(ui.model.feedbackOpen && ui.model.isExpanded));
  ui.view.feedbackBox.hidden = !canReport || !ui.model.feedbackOpen || !ui.model.isExpanded;
};

export const applyCardExpansion = (ui: OverlayUI, expanded: boolean) => {
  ui.model.isExpanded = expanded;
  if (!expanded) ui.model.feedbackOpen = false;
  ui.view.card.classList.toggle('is-expanded', expanded);
  ui.view.card.classList.toggle('is-collapsed', !expanded);
  ui.view.expandToggle.hidden = expanded || !ui.model.collapsible;
  ui.view.collapseChip.hidden = !expanded || !ui.model.collapsible;
  ui.view.expandToggle.setAttribute('aria-expanded', String(expanded));
  ui.view.copyTrace.hidden = !ui.model.current.canCopyTrace || (!expanded && ui.model.current.mode === 'running');
  const isCleanDone = ui.model.current.mode === 'done' && !ui.view.card.classList.contains('has-warn');
  const showMiniProgress = !expanded && (ui.model.current.mode === 'running' || isCleanDone);
  ui.view.pillProgress.hidden = !showMiniProgress;
  syncFeedbackUI(ui);
};

export const updateCard = (ui: OverlayUI, next: FeedbackState) => {
  if (next.taskId !== ui.model.lastTaskId) {
    ui.model.lastTaskId = next.taskId;
    ui.model.feedbackOpen = false;
    ui.model.feedbackSubmitted = false;
    ui.model.feedbackBusy = false;
    ui.model.feedbackReasons.clear();
    ui.model.lastFeedbackSummary = '';
    ui.view.feedbackStatus.textContent = '';
    ui.view.feedbackStatus.hidden = true;
    ui.view.feedbackStatus.classList.remove('error');
    ui.view.feedbackCopy.hidden = true;
    ui.view.feedbackSubmit.disabled = false;
    ui.view.feedbackSubmit.textContent = '生成诊断';
    for (const chip of ui.view.feedbackTagButtons) chip.setAttribute('aria-pressed', 'false');
  }
  const modeChanged = next.mode !== ui.model.lastMode;
  const newWaitingQuestion =
    next.mode === 'waiting' && Boolean(next.question?.id) && next.question?.id !== ui.model.lastQuestionId;
  if (modeChanged || newWaitingQuestion) {
    ui.model.expandedOverride = null;
    ui.model.lastMode = next.mode;
  }
  ui.model.current = next;
  syncViewportGlow(next.mode);
  const waitingForDialog = next.mode === 'waiting' && next.question?.blockingDialog === true;
  positionFeedbackCard(ui.view.host, waitingForDialog);
  let filledCount = next.filledCount || 0;
  const rawUnfilled = next.unfilledItems || [];
  let removedConsentCount = 0;
  const unfilled = rawUnfilled.filter(item => {
    if (item.kind === 'consent' && ui.fields.isConsentCheckedOnPage(item)) {
      filledCount++;
      removedConsentCount++;
      return false;
    }
    if (isPureReadOnlyDisplay(item, ui.fields.resolveFieldElement(item))) {
      return false;
    }
    return true;
  });
  ui.model.currentUnfilled = unfilled;
  const { optionalCount, actionableCount, auditIncomplete, verifyCount } = feedbackReviewCounts(unfilled);

  let nextTitle = next.title;
  let nextDetail = next.detail;
  if (
    (next.mode === 'done' || next.mode === 'paused') &&
    (removedConsentCount > 0 || unfilled.length !== rawUnfilled.length)
  ) {
    if (unfilled.length === 0) {
      nextTitle = filledCount > 0 ? `本页已填写 ${filledCount} 项信息` : '本页已完成填写';
      nextDetail = '请核对页面内容后手动提交。';
    } else if (actionableCount === 0 && verifyCount > 0) {
      nextTitle = `有 ${verifyCount} 项待核对`;
      nextDetail = '可定位到网页查看当前内容。';
    } else if (actionableCount === 0 && auditIncomplete) {
      nextTitle = '整表核查未完成';
      nextDetail = '已填写的内容已保留，可在下方重新核查。';
    } else if (actionableCount === 0) {
      nextTitle = '填写完成，请核对后提交';
      nextDetail = `已自动填写 ${filledCount} 项；下方 ${optionalCount} 项为网页选填项，可直接在面板补填或留空。`;
    } else {
      nextTitle =
        optionalCount > 0
          ? `仍有 ${actionableCount} 项信息未填写（另有 ${optionalCount} 项选填）`
          : `仍有 ${actionableCount} 项信息未填写`;
    }
  }

  const resolvedLiveOnPage = removedConsentCount > 0 && actionableCount === 0 && verifyCount === 0 && !auditIncomplete;
  const hasDoneWarn =
    next.mode === 'done' && !resolvedLiveOnPage && (actionableCount > 0 || verifyCount > 0 || auditIncomplete || next.warn === true || (next.stage ?? 3) < 3);
  const collapsible = next.mode !== 'connect' && !waitingForDialog;
  ui.model.collapsible = collapsible;
  const defaultExpanded =
    !collapsible ||
    next.mode === 'waiting' ||
    next.mode === 'paused' ||
    (next.mode === 'done' && (unfilled.length > 0 || hasDoneWarn));
  const expanded = !collapsible || (ui.model.expandedOverride !== null ? ui.model.expandedOverride : defaultExpanded);
  const hasLiveDetail = Boolean(nextDetail && nextDetail.trim());
  ui.view.card.className = `card ${next.mode}${hasDoneWarn ? ' has-warn' : ''}${waitingForDialog ? ' beside-dialog' : ''}${hasLiveDetail ? ' has-live-detail' : ''}`;
  applyCardExpansion(ui, expanded);
  ui.view.brand.hidden = next.mode !== 'connect';
  ui.view.stageTrack.hidden = next.mode === 'connect' || waitingForDialog;

  const completedAll = next.mode === 'done' && (next.stage ?? 3) >= 3;
  const activeStage = completedAll ? 3 : Math.min(3, Math.max(0, next.stage ?? 0));
  ui.view.pillSegs.forEach((seg, idx) => {
    if (completedAll || idx < activeStage) seg.className = 'pill-seg done';
    else if (idx === activeStage && next.mode === 'running') seg.className = 'pill-seg active';
    else seg.className = 'pill-seg';
  });

  if (!ui.view.stageTrack.hidden) {
    const trackSig = `${next.mode}:${activeStage}:${completedAll ? 1 : 0}:${hasDoneWarn ? 1 : 0}`;
    if (trackSig !== ui.model.lastTrackSig) {
      ui.model.lastTrackSig = trackSig;
      ui.view.stageNodes.forEach((node, idx) => {
        const isPast = completedAll ? idx < 3 : idx < activeStage;
        const isCurrent = completedAll ? idx === 3 : idx === activeStage;
        if (isPast) {
          node.dotWrap.innerHTML =
            '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" fill="#dcfce7"/><path d="M5 8.2L7.1 10.3L11.2 5.8" stroke="#15803d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          node.label.className = 'stage-label done';
        } else if (isCurrent && completedAll) {
          if (hasDoneWarn) {
            node.dotWrap.innerHTML =
              '<span style="width:12px;height:12px;border-radius:999px;background:#fef3c7;display:grid;place-items:center;"><span style="width:6px;height:6px;border-radius:999px;background:#d97706;"></span></span>';
            node.label.className = 'stage-label active-wait';
          } else {
            node.dotWrap.innerHTML =
              '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" fill="#10b981"/><path d="M5 8.2L7.1 10.3L11.2 5.8" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            node.label.className = 'stage-label active-done';
          }
        } else if (isCurrent) {
          if (next.mode === 'running' || next.mode === 'waiting') {
            const dotColor = next.mode === 'waiting' ? '#f59e0b' : '#0869d8';
            node.dotWrap.innerHTML = `<span class="stage-halo"></span><span style="width:7px;height:7px;border-radius:999px;background:${dotColor};position:relative;z-index:1;"></span>`;
            node.label.className = next.mode === 'waiting' ? 'stage-label active-wait' : 'stage-label active-run';
          } else {
            node.dotWrap.innerHTML =
              '<span style="width:7px;height:7px;border-radius:999px;background:#64748b;"></span>';
            node.label.className = 'stage-label active-pause';
          }
        } else {
          node.dotWrap.innerHTML = '<span style="width:6px;height:6px;border-radius:999px;background:#cbd5e1;"></span>';
          node.label.className = 'stage-label';
        }
        if (node.lineFill) {
          node.lineFill.className = idx < activeStage || completedAll ? 'stage-line-fill filled' : 'stage-line-fill';
        }
        if (node.lineBeam) {
          node.lineBeam.hidden = !(idx === activeStage && next.mode === 'running');
        }
      });
    }
  }

  ui.view.title.textContent = nextTitle;
  if (nextDetail !== ui.model.lastDetailText) {
    const hadPrevious = ui.model.lastDetailText !== '';
    ui.model.lastDetailText = nextDetail;
    ui.view.detail.textContent = nextDetail;
    if (hadPrevious && next.mode === 'running') {
      ui.view.detail.classList.remove('slide');
      void ui.view.detail.offsetWidth;
      ui.view.detail.classList.add('slide');
    } else {
      ui.view.detail.classList.remove('slide');
    }
  }

  const shouldPopPill = next.mode === 'running' && filledCount > ui.model.lastFilledCount;
  ui.model.lastFilledCount = filledCount;
  if (actionableCount > 0 && (next.mode === 'done' || next.mode === 'paused')) {
    ui.view.statPill.hidden = false;
    ui.view.statPill.className = 'stat-pill warn';
    ui.view.statPill.textContent = `已填 ${filledCount} 项 · ${actionableCount} 项未填`;
  } else if (verifyCount > 0 && (next.mode === 'done' || next.mode === 'paused')) {
    ui.view.statPill.hidden = false;
    ui.view.statPill.className = 'stat-pill warn';
    ui.view.statPill.textContent = `已填 ${filledCount} 项 · ${verifyCount} 项待核对`;
  } else if (optionalCount > 0 && (next.mode === 'done' || next.mode === 'paused')) {
    ui.view.statPill.hidden = false;
    ui.view.statPill.className = 'stat-pill';
    ui.view.statPill.textContent = `已填 ${filledCount} 项 · ${optionalCount} 项选填留空`;
  } else if (filledCount > 0) {
    ui.view.statPill.hidden = false;
    ui.view.statPill.className = 'stat-pill';
    ui.view.statPill.textContent = `已填 ${filledCount} 项`;
    if (shouldPopPill) {
      ui.view.statPill.classList.remove('pop');
      void ui.view.statPill.offsetWidth;
      ui.view.statPill.classList.add('pop');
    }
  } else {
    ui.view.statPill.hidden = true;
  }

  if (unfilled.length > 0 && (next.mode === 'done' || next.mode === 'paused')) {
    ui.view.unfilledBox.hidden = false;
    const summary =
      actionableCount === 0
        ? optionalCount > 0 ? `选填留空：${optionalCount} 项（可不填）` : ''
        : optionalCount > 0
          ? `报备：有 ${actionableCount} 项信息未填写 · ${optionalCount} 项选填可不填`
          : `报备：有 ${actionableCount} 项信息未填写`;
    ui.view.unfilledSummary.textContent = [
      summary,
      verifyCount > 0 ? `${verifyCount} 项待核对` : '',
      auditIncomplete ? '整表核查未完成' : '',
    ].filter(Boolean).join(' · ');
    renderUnfilledList(ui, unfilled);
  } else {
    ui.view.unfilledBox.hidden = true;
  }

  const q = next.mode === 'waiting' ? next.question : null;
  ui.view.button.hidden = false;
  if (next.mode === 'running') {
    ui.view.button.textContent = '暂停';
    ui.view.button.className = 'primary';
    ui.view.button.disabled = false;
    ui.view.secondaryBtn.hidden = true;
    ui.view.extra.hidden = true;
  } else if (next.mode === 'done') {
    ui.view.button.textContent = '我知道了';
    ui.view.button.className = 'primary';
    ui.view.button.disabled = false;
    ui.view.secondaryBtn.hidden = true;
    ui.view.extra.hidden = true;
  } else if (next.mode === 'connect') {
    ui.view.button.textContent = next.buttonText || '打开简历与模型设置 ↗';
    ui.view.button.className = 'primary highlight';
    ui.view.button.disabled = false;
    ui.view.secondaryBtn.textContent = '关闭';
    ui.view.secondaryBtn.hidden = false;
    ui.view.secondaryBtn.disabled = false;
    ui.view.extra.hidden = true;
  } else if (next.mode === 'paused') {
    ui.view.button.textContent = '继续填写';
    ui.view.button.className = 'primary highlight';
    ui.view.button.disabled = false;
    ui.view.secondaryBtn.hidden = true;
    ui.view.extra.hidden = true;
  } else if (q) {
    ui.view.button.disabled = false;
    ui.view.button.className = 'primary highlight';
    ui.view.secondaryBtn.hidden = false;
    ui.view.secondaryBtn.disabled = false;
    if (q.kind === 'manual_action') {
      const isConsentPrompt = /协议|隐私|条款|承诺|知情|授权|勾选/.test(q.question);
      ui.view.button.textContent = isConsentPrompt ? '同意并继续' : '我已完成，继续';
      ui.view.secondaryBtn.textContent = '稍后处理';
      ui.view.extra.hidden = true;
    } else if (q.replacement) {
      ui.view.button.textContent = '确认替换';
      ui.view.secondaryBtn.textContent = '保留原值';
      ui.view.extra.hidden = true;
    } else {
      const isSingleConsentOption = q.options?.length === 1 && q.options[0] === '同意';
      const hasFixedOptions = Boolean(q.options?.length && !isSingleConsentOption);
      ui.view.button.hidden = hasFixedOptions && !q.multiple;
      ui.view.button.textContent = isSingleConsentOption ? '同意并继续' : '提交并继续';
      ui.view.secondaryBtn.textContent = '跳过';
      ui.view.extra.hidden = false;
      if (ui.model.lastQuestionId !== q.id) {
        ui.model.lastQuestionId = q.id;
        ui.view.answerInput.value = '';
        ui.model.selectedOptions.clear();
      }
      ui.view.optionsBox.innerHTML = '';
      if (q.options?.length) {
        ui.view.optionsBox.hidden = false;
        ui.view.answerInput.hidden = true;
        for (const opt of q.options) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'chip';
          chip.textContent = opt;
          chip.setAttribute('aria-pressed', String(ui.model.selectedOptions.has(opt)));
          chip.addEventListener('click', ev => {
            if (!ev.isTrusted) return;
            if (q.multiple) {
              if (ui.model.selectedOptions.has(opt)) ui.model.selectedOptions.delete(opt);
              else ui.model.selectedOptions.add(opt);
              chip.setAttribute('aria-pressed', String(ui.model.selectedOptions.has(opt)));
              ui.view.button.disabled = ui.model.selectedOptions.size === 0;
              return;
            }
            if (opt === '同意' && /协议|隐私|条款|承诺|知情|授权|勾选/.test(q.question)) {
              ui.fields.checkConsentOnPage(null);
            }
            sendAnswer(ui, 'answer', opt);
          });
          ui.view.optionsBox.append(chip);
        }
        if (q.multiple) ui.view.button.disabled = ui.model.selectedOptions.size === 0;
      } else {
        ui.view.optionsBox.hidden = true;
        ui.view.answerInput.hidden = false;
        ui.view.answerInput.placeholder = '直接输入补充信息，按回车或点击提交…';
      }
    }
  } else {
    ui.view.button.textContent = '等待确认';
    ui.view.button.className = 'primary';
    ui.view.button.disabled = true;
    ui.view.secondaryBtn.hidden = true;
    ui.view.extra.hidden = true;
  }
};
