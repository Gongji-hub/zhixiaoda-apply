import type { FeedbackFieldFillResponse } from '../feedbackOverlay';
import type { FeedbackReviewItem } from '../feedbackSummary';
import { inferEffectiveKind, sendRuntimeMessage } from './controls';
import { type OverlayUI, type RowRecord } from './model';
import { openOptionsDrawer } from './optionsDrawer';
import { refreshHeaderOnLocalResolve } from './reviewListState';

export const createRowRecord = (ui: OverlayUI, initialItem: FeedbackReviewItem): RowRecord => {
  let item = initialItem;
  if (item.options?.length && !ui.model.optionCache.has(item.key)) {
    ui.model.optionCache.set(item.key, {
      options: item.options,
      typable: item.typable,
      multiple: item.multiple,
    });
  }

  const row = document.createElement('div');
  const main = document.createElement('div');
  main.className = 'item-main';

  const meta = document.createElement('div');
  meta.className = 'unfilled-meta';
  const tag = document.createElement('span');
  const copy = document.createElement('div');
  copy.className = 'field-copy';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'field-name';
  const reasonSpan = document.createElement('span');
  reasonSpan.className = 'field-reason';
  copy.append(nameSpan, reasonSpan);
  meta.append(tag, copy);

  const actBox = document.createElement('div');
  actBox.className = 'item-actions';

  const drawer = document.createElement('div');
  drawer.className = 'item-drawer';
  drawer.hidden = true;

  const errorLine = document.createElement('div');
  errorLine.className = 'item-error';
  errorLine.hidden = true;

  const inlineMount = document.createElement('div');
  inlineMount.style.cssText = 'display:inline-flex;align-items:center;gap:5px;';

  const locateBtn = document.createElement('button');
  locateBtn.type = 'button';
  locateBtn.className = 'mini-btn';
  locateBtn.textContent = '定位 ⌖';

  const showError = (msg: string) => {
    const cleaned = msg.replace(/^[A-Z_]+:\s*/, '').trim();
    errorLine.textContent = cleaned;
    errorLine.hidden = !cleaned;
  };

  const closeDrawer = () => {
    drawer.hidden = true;
    const trigger = inlineMount.querySelector<HTMLButtonElement>('.inline-select');
    if (trigger) trigger.classList.remove('open');
    if (ui.model.openDrawerKey === item.key) ui.model.openDrawerKey = '';
  };

  const applyTagAndReason = () => {
    const isResolved = ui.model.resolvedKeys.has(item.key);
    row.className = `unfilled-item${isResolved ? ' resolved' : ''}`;
    nameSpan.textContent = item.label;
    locateBtn.hidden = item.kind === 'audit';
    if (isResolved) {
      tag.className = 'tag ok';
      tag.textContent = '已补充';
      const committed = ui.model.resolvedValues.get(item.key);
      reasonSpan.textContent = committed ? `已填入：${committed} ✓` : '已完成 ✓';
      inlineMount.hidden = true;
      closeDrawer();
      showError('');
      return;
    }
    inlineMount.hidden = false;
    if (item.kind === 'consent') {
      tag.className = 'tag consent';
      tag.textContent = '协议';
    } else if (item.kind === 'attachment') {
      tag.className = 'tag file';
      tag.textContent = '附件';
    } else if (item.kind === 'verify' || item.kind === 'audit') {
      tag.className = 'tag warn';
      tag.textContent = item.kind === 'audit' ? '未完成' : '待核对';
    } else if (item.kind === 'failed') {
      tag.className = 'tag warn';
      tag.textContent = '待补填';
    } else if (item.required) {
      tag.className = 'tag req';
      tag.textContent = '需补充';
    } else {
      tag.className = 'tag';
      tag.textContent = '选填';
    }
    reasonSpan.textContent = item.reason;
  };

  const markResolved = (committedValue = '') => {
    ui.model.resolvedKeys.add(item.key);
    if (committedValue) ui.model.resolvedValues.set(item.key, committedValue);
    applyTagAndReason();
    refreshHeaderOnLocalResolve(ui);
  };

  const bindLiveWatch = (el: Element) => {
    const onEdit = () => {
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        if (el.checked) markResolved();
      } else if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        if (el.value.trim()) markResolved(el.value.trim());
      } else if ((el.textContent || '').trim()) {
        markResolved((el.textContent || '').trim());
      }
    };
    el.addEventListener('input', onEdit, { once: true });
    el.addEventListener('change', onEdit, { once: true });
  };

  const handleLocate = (ev: Event) => {
    ev.stopPropagation();
    if (item.kind === 'audit') return;
    if (item.manualOnly) {
      void sendRuntimeMessage<{ ok?: boolean; error?: string }>({ type: 'application_feedback_field_action',
        taskId: ui.model.current.taskId, token: ui.model.current.token, key: item.key, action: 'locate' })
        .then(result => { if (!result?.ok) showError(result?.error || '定位失败，请重新检查表单。'); });
      return;
    }
    const el = ui.fields.resolveFieldElement(item);
    if (el) {
      ui.fields.highlightTargetElement(el, `请在此补充 · ${item.label}`);
      bindLiveWatch(el);
    }
  };
  locateBtn.addEventListener('click', handleLocate);
  meta.addEventListener('click', handleLocate);

  // Build inline interactive control based on field kind.
  const liveEl = ui.fields.resolveFieldElement(item);
  const effectiveKind = inferEffectiveKind(item, liveEl);
  const drawerRow = {
    get item() {
      return item;
    },
    drawer,
    inlineMount,
    showError,
    markResolved,
  };

  if (item.manualOnly) {
    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.className = 'mini-btn';
    checkBtn.textContent = '重新核查';
    checkBtn.addEventListener('click', async ev => {
      ev.stopPropagation();
      checkBtn.disabled = true;
      try {
        const result = await sendRuntimeMessage<{ ok?: boolean; error?: string }>({ type: 'application_feedback_field_action',
          taskId: ui.model.current.taskId, token: ui.model.current.token, key: item.key, action: 'check' });
        if (!result?.ok) showError(result?.error || '核查失败，请稍后重试。');
      } finally { checkBtn.disabled = false; }
    });
    inlineMount.append(checkBtn);
  } else if (item.kind === 'consent') {
    const consentBtn = document.createElement('button');
    consentBtn.type = 'button';
    consentBtn.className = 'mini-btn accent';
    consentBtn.textContent = '一键勾选';
    consentBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      const el = ui.fields.resolveFieldElement(item);
      if (el) ui.fields.highlightTargetElement(el, `已勾选 · ${item.label}`);
      if (ui.fields.checkConsentOnPage(el)) {
        markResolved('已勾选');
        void sendRuntimeMessage({
          type: 'application_feedback_fill_field',
          taskId: ui.model.current.taskId,
          token: ui.model.current.token,
          key: item.key,
          value: '同意',
        });
      }
    });
    inlineMount.append(consentBtn);
  } else if (item.kind !== 'attachment') {
    if (effectiveKind === 'select' || effectiveKind === 'combobox') {
      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'inline-select';
      const hintText = item.expectedValue ? `选择（拟：${item.expectedValue}）` : '请选择';
      const labelNode = document.createElement('span');
      labelNode.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      labelNode.textContent = hintText;
      const caret = document.createElement('span');
      caret.textContent = '▾';
      selectBtn.append(labelNode, caret);
      selectBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        if (!drawer.hidden) {
          closeDrawer();
        } else {
          openOptionsDrawer(ui, drawerRow);
        }
      });
      inlineMount.append(selectBtn);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'inline-input';
      if (item.expectedValue && (item.kind === 'failed' || item.kind === 'verify')) {
        input.value = item.expectedValue;
      }
      if (effectiveKind === 'date') {
        input.placeholder = item.dateFormat === 'YYYY-MM' ? '如 2025-09' : '如 2025-09-01';
      } else {
        input.placeholder = '直接输入，回车填入';
      }
      input.addEventListener('click', ev => ev.stopPropagation());

      const fillBtn = document.createElement('button');
      fillBtn.type = 'button';
      fillBtn.className = 'inline-btn';
      fillBtn.textContent = '填入';

      const submitInlineText = () => {
        const val = input.value.trim();
        if (!val) {
          input.focus();
          return;
        }
        input.disabled = true;
        fillBtn.disabled = true;
        fillBtn.textContent = '填入中…';
        showError('');
        void sendRuntimeMessage<FeedbackFieldFillResponse>({
          type: 'application_feedback_fill_field',
          taskId: ui.model.current.taskId,
          token: ui.model.current.token,
          key: item.key,
          value: val,
        }).then(res => {
          input.disabled = false;
          fillBtn.disabled = false;
          fillBtn.textContent = '填入';
          if (res?.ok && res.status === 'cascader_next' && res.options?.length) {
            openOptionsDrawer(ui, drawerRow, {
              options: res.options,
              typable: false,
              multiple: false,
              pathPrefix: res.pathPrefix || val,
            });
            return;
          }
          if (res?.ok && res.status === 'filled') {
            markResolved(res.actualValue || val);
            return;
          }
          if (res?.options?.length) {
            openOptionsDrawer(ui, drawerRow, {
              options: res.options,
              typable: res.typable,
              multiple: res.multiple,
            });
            showError(res.error || res.message || '请从下方候选项中选择匹配项。');
            return;
          }
          showError(res?.error || res?.message || '未能自动填入，请点击定位在网页核对。');
        });
      };

      fillBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        submitInlineText();
      });
      input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' && !ev.isComposing) {
          ev.preventDefault();
          submitInlineText();
        }
      });
      inlineMount.append(input, fillBtn);
    }
  }

  actBox.append(inlineMount, locateBtn);
  main.append(meta, actBox);
  row.append(main, drawer, errorLine);
  applyTagAndReason();

  return {
    item,
    row,
    syncItem: (nextItem: FeedbackReviewItem) => {
      item = nextItem;
      if (nextItem.options?.length && !ui.model.optionCache.has(nextItem.key)) {
        ui.model.optionCache.set(nextItem.key, {
          options: nextItem.options,
          typable: nextItem.typable,
          multiple: nextItem.multiple,
        });
      }
      applyTagAndReason();
    },
    closeDrawer,
  };
};
