import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import { customDropdown } from './dropdownOptions';
import type { FormControlState } from './formControls';
import {
    pickNearbyOption,
    pickOwnedOption,
    readLiveControl,
    rememberFormSelection,
    writeFormText,
    writeMainWorldComponentState,
} from './formControls';
import { formValuesEquivalent, MissingFormInformationError } from './formFill';
import type { ApplicationControlOptions } from './page';
import type { PageDriver } from './pageDriver';
import { RECRUITING_ADAPTERS, recruitingOptions, type RecruitingOptions } from './recruitingAdapters';

/** 点开（或输入筛选、滚动查找）字段自己的弹出列表，精确点中一个选项；支持分级级联展开与路径后缀匹配。 */

export function cascaderLeafMatch(candidate: string, target: string): boolean {
  const parts = candidate
    .split(/\s+\/\s+|\s*[>＞]\s*/)
    .map(part => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return false;
  const targetParts = target
    .split(/\s+\/\s+|\s*[>＞]\s*/)
    .map(part => part.trim())
    .filter(Boolean);
  if (!targetParts.length || targetParts.length > parts.length) return false;
  const offset = parts.length - targetParts.length;
  return targetParts.every((seg, i) => formValuesEquivalent(parts[offset + i], seg));
}

export async function chooseOption(
  driver: PageDriver,
  element: ElementHandle,
  text: string,
  signal?: AbortSignal,
  resolveOption?: ApplicationControlOptions['resolveOption'],
  trace?: ApplicationControlOptions['traceDropdown'],
): Promise<string> {
  const requested = text;
  const requestedSegments = requested
    .split(/\s+\/\s+|\s*[>＞]\s*/)
    .map(part => part.trim())
    .filter(Boolean);
  const { typable, search, searchHandle, adapted, declared, listed, open, rewind, scroll, close, clickGuarded, wait } =
    await customDropdown(driver, element, text, signal);
  let succeeded = false;
  const selectedPath: string[] = [];
  const prefixOptions = (opts: string[]) => {
    const prefix = selectedPath.join(' / ');
    return prefix ? opts.map(opt => (opt.includes(' / ') ? opt : `${prefix} / ${opt}`)) : opts;
  };
  const traceOptions = (phase: string, state: { open: boolean; matches: number; options: string[] }) => {
    trace?.(phase, `弹层${state.open ? '已打开' : '未打开'}，可见 ${state.options.length} 项，精确匹配 ${state.matches} 项`);
  };
  const matchCascaderLevel = (opts: string[], depth: number): string | null => {
    const eq = opts.filter(c => formValuesEquivalent(c, requested));
    if (eq.length === 1) return eq[0];
    const leaf = opts.filter(c => cascaderLeafMatch(c, requested));
    if (leaf.length === 1) return leaf[0];
    if (depth > 0 && requestedSegments.length > 1) {
      const seg = requestedSegments[depth - 1];
      if (seg) {
        const segEq = opts.filter(c => formValuesEquivalent(c, seg));
        if (segEq.length === 1) return segEq[0];
      }
    }
    if (depth > 0 && requestedSegments.length === 1) {
      let rest = requested.trim();
      for (const seg of selectedPath) {
        const s = seg.trim();
        if (s && rest.startsWith(s)) {
          rest = rest.slice(s.length).replace(/^[\s/>＞\-·,，]+/, '').trim();
        }
      }
      if (rest) {
        const restEq = opts.filter(c => formValuesEquivalent(c, rest));
        if (restEq.length === 1) return restEq[0];
        const prefixEq = opts.filter(c => c.length >= 2 && rest.startsWith(c) && rest.length > c.length);
        if (prefixEq.length === 1) return prefixEq[0];
      }
    }
    return null;
  };
  try {
    trace?.('打开', '尝试打开字段的下拉');
    let state = await open(true);
    traceOptions('打开回读', state);
    let searchOptions: string[] = [];
    const initialCascaderMatch = matchCascaderLevel(state.options, (state as RecruitingOptions).cascaderDepth ?? 0);
    if (!state.matches && typable && initialCascaderMatch === null) {
      trace?.('搜索', '用拟填写值筛选候选');
      const beforeSearchSig = state.options.join('\n');
      signal?.throwIfAborted();
      await search!.evaluate(writeFormText, '');
      signal?.throwIfAborted();
      await search!.type(text, { delay: 20 });
      let prevSig = '';
      for (let poll = 0; poll < 15 && !state.matches; poll++) {
        await wait(150);
        state = await listed();
        if (state.matches || state.options.some(opt => cascaderLeafMatch(opt, requested))) break;
        const sig = state.options.join('\n');
        if (poll >= 2 && sig !== beforeSearchSig && sig === prevSig && state.options.length > 0) break;
        prevSig = sig;
      }
      traceOptions('搜索回读', state);
      const hasLeaf = state.options.some(opt => cascaderLeafMatch(opt, requested));
      // 有的下拉能输入但不按输入筛选（或搜索无匹配需退回分级菜单）：清掉输入，回到完整列表里查找。
      if (!state.matches && !hasLeaf && !(resolveOption && state.options.length)) {
        searchOptions = state.options;
        signal?.throwIfAborted();
        await search!.evaluate(writeFormText, '');
        await wait(380);
        state = await listed();
      }
    }
    for (let level = 0; level < 4; level++) {
      if (level > 0) {
        text = requested;
        state = await listed(text);
      }
      const depth = (state as RecruitingOptions).cascaderDepth ?? 0;
      const pathFullyMatched =
        selectedPath.length > 0 && formValuesEquivalent(requested, selectedPath.join(' / ')) && state.options.length > 0;
      const directLevelMatch = matchCascaderLevel(state.options, depth);
      const hasDirectTarget = state.matches > 0 || directLevelMatch !== null || pathFullyMatched;
      if (!hasDirectTarget) state = await rewind(state, text);
      const candidates = new Set(state.options);
      let exhausted = hasDirectTarget;
      for (let round = 0; round < 80 && !hasDirectTarget && !state.matches; round++) {
        const next = await scroll(state, text);
        if (!next) {
          exhausted = true;
          break;
        }
        state = next;
        state.options.forEach(option => candidates.add(option));
      }
      if (!state.matches && !exhausted && !candidates.size)
        throw new Error('下拉候选尚未遍历完，不能将部分选项交给 Agent 判断。');
      if (!state.matches && candidates.size) {
        if (selectedPath.length > 0 && formValuesEquivalent(requested, selectedPath.join(' / '))) {
          throw new MissingFormInformationError(
            `请继续选择「${selectedPath.join(' / ')}」下的具体项。`,
            prefixOptions([...candidates]),
          );
        }
        let selected: string | null = matchCascaderLevel([...candidates], depth);
        if (selected === null && requestedSegments.length > 0) {
          const prefixMatches = [...candidates].filter(candidate => {
            const parts = candidate
              .split(/\s+\/\s+/)
              .map(part => part.trim())
              .filter(Boolean);
            return (
              parts.length > requestedSegments.length &&
              requestedSegments.every((seg, idx) => formValuesEquivalent(parts[idx], seg))
            );
          });
          if (prefixMatches.length > 1 && prefixMatches.length === candidates.size) {
            throw new MissingFormInformationError(
              `请继续选择「${requestedSegments.join(' / ')}」下的具体项。`,
              prefixMatches,
            );
          }
        }
        if (selected === null && resolveOption) {
          const control = await readLiveControl(element, true);
          try {
            selected = await resolveOption({
              requested,
              candidates: [...candidates],
              fieldText: control.context ?? '',
            });
          } catch (err) {
            if (err instanceof MissingFormInformationError && selectedPath.length > 0) {
              throw new MissingFormInformationError(err.message, prefixOptions(err.options));
            }
            throw err;
          }
          if (signal?.aborted) throw new Error('操作已取消。');
          if (selected === null) {
            const err = new Error(
              `Agent 无法确定适合「${requested}」的候选名称或类别。实际候选：${[...candidates].join('、')}。请结合资料进一步确认。`,
            ) as Error & { options?: string[] };
            err.options = prefixOptions([...candidates]);
            throw err;
          }
          if (!candidates.has(selected)) throw new Error('Agent 返回的候选不在实际列表中，未点击。');
        }
        if (selected !== null) {
          text = selected;
          // Use the original filtered list: searching again with its label could change the remote results.
          state = await listed(text);
          if (!state.matches) {
            state = await rewind(state, text);
            for (let round = 0; round < 80 && !state.matches; round++) {
              const next = await scroll(state, text);
              if (!next) break;
              state = next;
            }
          }
        }
      }
      // A search/model response or viewport scroll may remount the list. Resolve
      // the option handle only after reading the freshly revealed popup.
      state = await listed(text);
      traceOptions('候选确认', state);
      if (state.matches !== 1) {
        const err = new Error(
          state.matches > 1
            ? `有多个与「${text}」完全相同的选项，无法区分。`
            : `没有与「${text}」完全一致的选项。搜索结果：${searchOptions.join('、') || '无'}；当前可见选项：${state.options.join('、') || '无'}。请核对候选是否与资料一致，再选择精确文本，不得把不同实体直接替换。`,
        ) as Error & { options?: string[] };
        err.options = prefixOptions(candidates.size ? [...candidates] : state.options);
        throw err;
      }
      let option: ElementHandle | null = null;
      if (adapted) {
        const handle = await element.evaluateHandle(recruitingOptions, RECRUITING_ADAPTERS, text, true);
        option = handle.asElement() as ElementHandle | null;
        if (!option) await handle.dispose();
      }
      for (const finder of adapted ? [] : declared ? [pickOwnedOption] : [pickOwnedOption, pickNearbyOption]) {
        const handle = await element.evaluateHandle(finder, text);
        option = handle.asElement() as ElementHandle | null;
        if (option) break;
        await handle.dispose();
      }
      if (!option) {
        trace?.('点击', '最终定位时找不到刚确认的候选');
        throw new Error('选项已变化，请重新观察。');
      }
      try {
        const beforeDepth = (state as RecruitingOptions).cascaderDepth ?? 0;
        // Focusing a popup checkbox before its mousedown can blur and close the dropdown.
        trace?.('点击', '已定位候选，开始点击');
        await clickGuarded(option, false);
        trace?.('点击', '点击已返回，开始回读');
        if (beforeDepth > 0 && level < 3) {
          await wait(120);
          const nextState = (await listed('')) as RecruitingOptions;
          if (nextState.open && (nextState.cascaderDepth ?? 0) > beforeDepth) {
            selectedPath.push(text);
            continue;
          }
        }
        const matchesSelected = (ctrl: FormControlState) => {
          if (!ctrl.value.trim()) return false;
          if (ctrl.multiple) {
            const norm = (val: string) => val.replace(/\s*[×✕✖](?=\s*(?:[,，、\n]|$))/gu, '').replace(/\s+/g, '');
            return ctrl.selectedValues
              ? ctrl.selectedValues.some(val => norm(val) === norm(text))
              : norm(ctrl.value).includes(norm(text));
          }
          return formValuesEquivalent(ctrl.value, text) || cascaderLeafMatch(ctrl.value, text);
        };
        // Poll native click commit first so array-backed cascader v-models are never overwritten by string fallback.
        let control = await readLiveControl(element, true);
        for (let poll = 0; adapted && !matchesSelected(control) && poll < 3; poll++) {
          if (signal?.aborted) throw new Error('操作已取消。');
          await wait(60);
          control = await readLiveControl(element, true);
          if (matchesSelected(control) && control.selectionConfirmed !== false) break;
        }
        if (control.selectionConfirmed === false || !matchesSelected(control)) {
          signal?.throwIfAborted();
          await element.evaluate(writeMainWorldComponentState, text, option).catch(() => false);
          control = await readLiveControl(element, true);
        }
        if (control.selectionConfirmed === false) {
          let committed = false;
          for (let poll = 0; poll < 10; poll++) {
            if (signal?.aborted) throw new Error('操作已取消。');
            await wait(100);
            const current = await readLiveControl(element, true);
            if (matchesSelected(current) && (current.selectionConfirmed === true || !(await listed()).open)) {
              if (current.selectionConfirmed !== true) await element.evaluate(rememberFormSelection, current.value);
              control = current;
              committed = true;
              break;
            }
          }
          if (!committed) {
            trace?.('选中回读', '网页尚未确认选中');
            throw new Error('点击候选后尚未确认选中：输入框文字或弹层状态未完成更新。');
          }
        }
        trace?.('选中回读',
          `回读${control.value.trim() ? '有值' : '为空'}，与候选${matchesSelected(control) ? '匹配' : '不匹配'}，网页校验${control.valid ? '通过' : '未通过'}`);
        if (!control.multiple && Boolean(control.value.trim()) && cascaderLeafMatch(control.value, text)) {
          text = control.value;
        }
        succeeded = true;
        return text;
      } finally {
        await option.dispose();
      }
    }
    throw new Error('级联菜单层级超过上限，未能完成叶子节点选择。');
  } finally {
    // 选后保留控件自己的展开和焦点状态，多选可能还需要继续勾选；失败退出时收起残留弹层以免遮挡下方字段。
    if (!succeeded) await close().catch(() => undefined);
    await searchHandle.dispose();
  }
}
