import { type OverlayUI } from './model';
import { feedbackReviewCounts } from '../feedbackSummary';

export const closeAllDrawersExcept = (ui: OverlayUI, keepKey = '') => {
  ui.model.openDrawerKey = keepKey;
  for (const [key, rec] of ui.model.rowRecords) {
    if (key !== keepKey) rec.closeDrawer();
  }
};

export const refreshHeaderOnLocalResolve = (ui: OverlayUI) => {
  if (ui.model.current.mode !== 'done' && ui.model.current.mode !== 'paused') return;
  const localResolvedCount = ui.model.currentUnfilled.filter(i => ui.model.resolvedKeys.has(i.key)).length;
  if (localResolvedCount === 0) return;
  const effectiveFilled = ui.model.lastFilledCount + localResolvedCount;
  const remaining = ui.model.currentUnfilled.filter(i => !ui.model.resolvedKeys.has(i.key));
  const { optionalCount, actionableCount, auditIncomplete, verifyCount } = feedbackReviewCounts(remaining);
  if (actionableCount > 0) {
    ui.view.statPill.hidden = false;
    ui.view.statPill.className = 'stat-pill warn';
    ui.view.statPill.textContent = `已填 ${effectiveFilled} 项 · ${actionableCount} 项未填`;
    ui.view.unfilledSummary.textContent =
      optionalCount > 0
        ? `报备：有 ${actionableCount} 项信息未填写 · ${optionalCount} 项选填可不填`
        : `报备：有 ${actionableCount} 项信息未填写`;
  } else if (verifyCount > 0) {
    ui.view.statPill.hidden = false;
    ui.view.statPill.className = 'stat-pill warn';
    ui.view.statPill.textContent = `已填 ${effectiveFilled} 项 · ${verifyCount} 项待核对`;
    ui.view.unfilledSummary.textContent = [
      `${verifyCount} 项待核对`,
      optionalCount > 0 ? `${optionalCount} 项选填留空` : '',
      auditIncomplete ? '整表核查未完成' : '',
    ].filter(Boolean).join(' · ');
    if (ui.model.current.mode === 'done') ui.view.title.textContent = `有 ${verifyCount} 项待核对`;
  } else if (auditIncomplete) {
    ui.view.statPill.hidden = false;
    ui.view.statPill.className = 'stat-pill warn';
    ui.view.statPill.textContent = `已填 ${effectiveFilled} 项`;
    ui.view.unfilledSummary.textContent = '整表核查未完成';
    if (ui.model.current.mode === 'done') ui.view.title.textContent = '整表核查未完成';
  } else if (optionalCount > 0) {
    ui.view.statPill.hidden = false;
    ui.view.statPill.className = 'stat-pill';
    ui.view.statPill.textContent = `已填 ${effectiveFilled} 项 · ${optionalCount} 项选填留空`;
    ui.view.unfilledSummary.textContent = `选填留空：${optionalCount} 项（可不填）`;
    if (ui.model.current.mode === 'done') {
      ui.view.card.classList.remove('has-warn');
      ui.view.title.textContent = '填写完成，请核对后提交';
    }
  } else {
    ui.view.statPill.hidden = false;
    ui.view.statPill.className = 'stat-pill';
    ui.view.statPill.textContent = `已填 ${effectiveFilled} 项`;
    ui.view.unfilledSummary.textContent = '本页待办项已全部补充';
    if (ui.model.current.mode === 'done') {
      ui.view.card.classList.remove('has-warn');
      ui.view.title.textContent = effectiveFilled > 0 ? `本页已填写 ${effectiveFilled} 项信息` : '本页已完成填写';
    }
  }
};
