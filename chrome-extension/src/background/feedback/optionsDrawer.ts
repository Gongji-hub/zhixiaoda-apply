import type { FeedbackFieldFillResponse } from '../feedbackOverlay';
import type { FeedbackReviewItem } from '../feedbackSummary';
import { sendRuntimeMessage } from './controls';
import { type OverlayUI } from './model';
import { closeAllDrawersExcept } from './reviewListState';

interface DrawerRow {
  readonly item: FeedbackReviewItem;
  drawer: HTMLDivElement;
  inlineMount: HTMLElement;
  showError: (message: string) => void;
  markResolved: (value: string) => void;
}
export const openOptionsDrawer = (
  ui: OverlayUI,
  row: DrawerRow,
  seed?: {
    options: string[];
    typable?: boolean;
    multiple?: boolean;
    pathPrefix?: string;
  },
) => {
  closeAllDrawersExcept(ui, row.item.key);
  row.drawer.hidden = false;
  const trigger = row.inlineMount.querySelector<HTMLButtonElement>('.inline-select');
  if (trigger) trigger.classList.add('open');

  if (seed) ui.model.optionCache.set(row.item.key, seed);
  let cached = ui.model.optionCache.get(row.item.key);
  const multiPicked = new Set<string>();

  const renderDrawerBody = (loading = false, filterText = '') => {
    row.drawer.innerHTML = '';
    if (cached?.pathPrefix) {
      const crumb = document.createElement('div');
      crumb.className = 'drawer-crumb';
      crumb.textContent = `当前层级：${cached.pathPrefix} / 请继续选择下级`;
      row.drawer.append(crumb);
    }

    const allowSearch = Boolean(
      cached?.typable || (cached && cached.options.length > 8) || (!loading && cached && cached.options.length === 0),
    );
    if (allowSearch) {
      const searchRow = document.createElement('div');
      searchRow.className = 'drawer-search-row';
      const searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.className = 'drawer-search';
      searchInput.value = filterText;
      searchInput.placeholder = cached?.typable ? '输入关键词筛选或回车远程搜索选项…' : '输入关键词筛选候选项…';
      searchInput.addEventListener('click', e => e.stopPropagation());
      searchRow.append(searchInput);

      const triggerRemoteSearch = () => {
        const q = searchInput.value.trim();
        if (!q) return;
        renderDrawerBody(true, q);
        void sendRuntimeMessage<FeedbackFieldFillResponse>({
          type: 'application_feedback_list_options',
          taskId: ui.model.current.taskId,
          token: ui.model.current.token,
          key: row.item.key,
          query: q,
        }).then(res => {
          cached = {
            options: res?.options || [],
            typable: res?.typable ?? true,
            multiple: res?.multiple ?? cached?.multiple,
            pathPrefix: cached?.pathPrefix,
          };
          ui.model.optionCache.set(row.item.key, cached);
          renderDrawerBody(false, '');
        });
      };

      if (cached?.typable) {
        const searchBtn = document.createElement('button');
        searchBtn.type = 'button';
        searchBtn.className = 'inline-btn';
        searchBtn.textContent = '搜索';
        searchBtn.addEventListener('click', e => {
          e.stopPropagation();
          triggerRemoteSearch();
        });
        searchRow.append(searchBtn);
      }

      row.drawer.append(searchRow);

      searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim().toLowerCase();
        const chips = row.drawer.querySelectorAll<HTMLButtonElement>('.drawer-chips .chip');
        chips.forEach(chip => {
          const txt = (chip.dataset.option || chip.textContent || '').toLowerCase();
          chip.hidden = Boolean(q) && !txt.includes(q);
        });
      });
      searchInput.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' && !ev.isComposing && cached?.typable) {
          ev.preventDefault();
          triggerRemoteSearch();
        }
      });
    }

    if (loading) {
      const status = document.createElement('div');
      status.className = 'drawer-status';
      status.textContent = '正在读取网页下拉选项…';
      row.drawer.append(status);
      return;
    }

    const opts = cached?.options || [];
    if (!opts.length) {
      const empty = document.createElement('div');
      empty.className = 'drawer-status';
      empty.textContent = cached?.typable
        ? '请输入关键词后点击「搜索」获取匹配项，或点右侧定位在网页选择。'
        : '暂未读取到候选项，可直接输入文本尝试填入或点右侧定位。';
      row.drawer.append(empty);
      if (!cached?.typable) {
        const fallbackRow = document.createElement('div');
        fallbackRow.className = 'drawer-search-row';
        const fbInput = document.createElement('input');
        fbInput.type = 'text';
        fbInput.className = 'drawer-search';
        fbInput.placeholder = '直接输入目标内容填入…';
        fbInput.value = row.item.expectedValue || '';
        const fbBtn = document.createElement('button');
        fbBtn.type = 'button';
        fbBtn.className = 'inline-btn';
        fbBtn.textContent = '填入';
        const submitFallback = () => {
          const val = fbInput.value.trim();
          if (!val) return;
          fbBtn.disabled = true;
          row.showError('');
          void sendRuntimeMessage<FeedbackFieldFillResponse>({
            type: 'application_feedback_fill_field',
            taskId: ui.model.current.taskId,
            token: ui.model.current.token,
            key: row.item.key,
            value: val,
          }).then(res => {
            fbBtn.disabled = false;
            if (res?.ok && res.status === 'cascader_next' && res.options?.length) {
              cached = {
                options: res.options,
                typable: cached?.typable,
                multiple: false,
                pathPrefix: res.pathPrefix,
              };
              ui.model.optionCache.set(row.item.key, cached);
              renderDrawerBody(false);
            } else if (res?.ok && res.status === 'filled') {
              row.markResolved(res.actualValue || val);
            } else {
              row.showError(res?.error || res?.message || '未能自动填入，请点击定位在网页操作。');
            }
          });
        };
        fbBtn.addEventListener('click', e => {
          e.stopPropagation();
          submitFallback();
        });
        fbInput.addEventListener('keydown', ev => {
          if (ev.key === 'Enter' && !ev.isComposing) {
            ev.preventDefault();
            submitFallback();
          }
        });
        fallbackRow.append(fbInput, fbBtn);
        row.drawer.append(fallbackRow);
      }
      return;
    }

    const chipsWrap = document.createElement('div');
    chipsWrap.className = 'drawer-chips';
    const isMulti = Boolean(cached?.multiple);
    let confirmMultiBtn: HTMLButtonElement | null = null;

    for (const opt of opts) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.option = opt;
      const prefix = cached?.pathPrefix ? `${cached.pathPrefix} / ` : '';
      chip.textContent = prefix && opt.startsWith(prefix) ? opt.slice(prefix.length) : opt;
      chip.setAttribute('aria-pressed', String(multiPicked.has(opt)));
      chip.addEventListener('click', ev => {
        ev.stopPropagation();
        if (isMulti) {
          if (multiPicked.has(opt)) multiPicked.delete(opt);
          else multiPicked.add(opt);
          chip.setAttribute('aria-pressed', String(multiPicked.has(opt)));
          if (confirmMultiBtn) confirmMultiBtn.disabled = multiPicked.size === 0;
          return;
        }
        chipsWrap.querySelectorAll('button').forEach(b => (b.disabled = true));
        row.showError('');
        void sendRuntimeMessage<FeedbackFieldFillResponse>({
          type: 'application_feedback_fill_field',
          taskId: ui.model.current.taskId,
          token: ui.model.current.token,
          key: row.item.key,
          value: opt,
        }).then(res => {
          if (res?.ok && res.status === 'cascader_next' && res.options?.length) {
            cached = {
              options: res.options,
              typable: false,
              multiple: false,
              pathPrefix: res.pathPrefix || opt,
            };
            ui.model.optionCache.set(row.item.key, cached);
            renderDrawerBody(false);
            return;
          }
          if (res?.ok && res.status === 'filled') {
            row.markResolved(res.actualValue || opt);
            return;
          }
          chipsWrap.querySelectorAll('button').forEach(b => (b.disabled = false));
          row.showError(res?.error || res?.message || '未能选中该项，请点击定位在网页操作。');
        });
      });
      chipsWrap.append(chip);
    }
    row.drawer.append(chipsWrap);

    if (isMulti) {
      const multiBar = document.createElement('div');
      multiBar.className = 'drawer-search-row';
      confirmMultiBtn = document.createElement('button');
      confirmMultiBtn.type = 'button';
      confirmMultiBtn.className = 'inline-btn';
      confirmMultiBtn.textContent = '确认选择';
      confirmMultiBtn.disabled = true;
      confirmMultiBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        const picked = [...multiPicked];
        if (!picked.length) return;
        confirmMultiBtn!.disabled = true;
        row.showError('');
        void sendRuntimeMessage<FeedbackFieldFillResponse>({
          type: 'application_feedback_fill_field',
          taskId: ui.model.current.taskId,
          token: ui.model.current.token,
          key: row.item.key,
          value: picked.join('、'),
          selectedOptions: picked,
        }).then(res => {
          if (res?.ok && res.status === 'filled') {
            row.markResolved(res.actualValue || picked.join('、'));
          } else {
            confirmMultiBtn!.disabled = false;
            row.showError(res?.error || res?.message || '多选写入未成功，请点击定位核对。');
          }
        });
      });
      multiBar.append(confirmMultiBtn);
      row.drawer.append(multiBar);
    }
  };

  if (cached && cached.options.length > 0) {
    renderDrawerBody(false);
  } else {
    renderDrawerBody(true);
    void sendRuntimeMessage<FeedbackFieldFillResponse>({
      type: 'application_feedback_list_options',
      taskId: ui.model.current.taskId,
      token: ui.model.current.token,
      key: row.item.key,
    }).then(res => {
      cached = {
        options: res?.options || [],
        typable: res?.typable ?? row.item.typable,
        multiple: res?.multiple ?? row.item.multiple,
      };
      ui.model.optionCache.set(row.item.key, cached);
      renderDrawerBody(false);
    });
  }
};
