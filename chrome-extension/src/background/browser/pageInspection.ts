import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import type { DOMElementNode } from './dom/views';
import { allSearchContexts, resolveElementFrame } from './elementLocation';
import type { FormControlState } from './formControls';
import { formFingerprint, readLiveControl, soleFormControl } from './formControls';
import type { PageDriver } from './pageDriver';
import { RECRUITING_ADAPTERS } from './recruitingAdapters';

export function formIdentity(node: DOMElementNode): Record<string, string> {
  return {
    tagName: (node.tagName ?? '').toLowerCase(),
    ...(node.attributes['data-qz-field'] ? { 'data-qz-field': node.attributes['data-qz-field'] } : {}),
    ...Object.fromEntries(
      ['id', 'name', 'type', 'role', 'contenteditable'].map(key => [key, node.attributes[key] ?? '']),
    ),
  };
}

/** 定位观察到的控件；指向外框时换成框内唯一的真实控件，身份核对随之改用该控件。 */

export async function applicationControl(
  driver: PageDriver,
  node: DOMElementNode,
  scroll = true,
): Promise<{ element: ElementHandle; identity: Record<string, string> }> {
  await driver.checkTarget();
  const located = await driver.page.locateElement(node, scroll);
  if (!located) throw new Error('目标控件已移除，请重新观察页面。');
  if (await located.isHidden()) throw new Error('目标控件已隐藏，请观察当前可用的交互入口。');
  const identity = formIdentity(node);
  const handle = await located.evaluateHandle(soleFormControl, RECRUITING_ADAPTERS);
  const inner = handle.asElement() as ElementHandle | null;
  if (!inner) {
    await handle.dispose();
    return { element: located, identity };
  }
  const outer = await readLiveControl(located, false);
  if (Object.entries(identity).some(([key, value]) => outer.identity[key] !== value))
    throw new Error('控件已变化或移除，请重新观察页面。');
  return { element: inner, identity: (await readLiveControl(inner, false)).identity };
}

/** 批量填写途中的轻量结构指纹，替代每个动作前完整重建 DOM 树。 */

export async function getFormFingerprint(driver: PageDriver): Promise<string | null> {
  if (!driver.puppeteer) return null;
  const parts: string[] = [];
  for (const ctx of allSearchContexts(driver)) {
    if (typeof ctx.$eval !== 'function') continue;
    const part = await ctx.$eval('body', formFingerprint, RECRUITING_ADAPTERS).catch(() => '');
    if (part) parts.push(part);
  }
  return parts.join('\n---\n');
}

/** 按观察到的路径给元素打稳定标记，已有标记的沿用；找不到的返回 null。支持跨 iframe 标注。 */

export async function tagApplicationElements(
  driver: PageDriver,
  xpaths: string[],
  nodes?: DOMElementNode[],
): Promise<(string | null)[]> {
  if (!driver.puppeteer) return xpaths.map(() => null);
  await driver.checkTarget();
  const hasIframeNode = Boolean(
    nodes?.some(node => {
      let p = node?.parent;
      while (p) {
        if (p.tagName?.toLowerCase() === 'iframe') return true;
        p = p.parent;
      }
      return false;
    }),
  );
  if (!hasIframeNode) {
    return driver.puppeteer.evaluate((paths: string[]) => {
      const holder = window as unknown as { __qzSeq?: number };
      return paths.map(path => {
        const fullPath = path ? (path.startsWith('/') ? path : `/${path}`) : '';
        let found = fullPath
          ? document.evaluate(fullPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
          : null;
        if (!found && (fullPath === '/body' || fullPath.startsWith('/body/'))) {
          found = document.evaluate(
            `/html${fullPath}`,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null,
          ).singleNodeValue;
        }
        if (!(found instanceof Element)) return null;
        const existing = found.getAttribute('data-qz-field');
        if (existing) return existing;
        holder.__qzSeq = (holder.__qzSeq ?? 0) + 1;
        const id = `q${holder.__qzSeq}`;
        found.setAttribute('data-qz-field', id);
        return id;
      });
    }, xpaths);
  }

  const baseSeq = await driver.puppeteer
    .evaluate((count: number) => {
      const holder = window as unknown as { __qzSeq?: number };
      const start = holder.__qzSeq ?? 0;
      holder.__qzSeq = start + count;
      return start;
    }, xpaths.length)
    .catch(() => 0);

  return Promise.all(
    xpaths.map(async (xpath, idx) => {
      if (!xpath) return null;
      const targetFrame = await resolveElementFrame(driver, nodes?.[idx]);
      if (!targetFrame || typeof targetFrame.evaluate !== 'function') return null;
      const candidateId = `q${baseSeq + idx + 1}`;
      return targetFrame
        .evaluate(
          (path: string, nextId: string) => {
            const fullPath = path ? (path.startsWith('/') ? path : `/${path}`) : '';
            let found = fullPath
              ? document.evaluate(fullPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
              : null;
            if (!found && (fullPath === '/body' || fullPath.startsWith('/body/'))) {
              found = document.evaluate(
                `/html${fullPath}`,
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null,
              ).singleNodeValue;
            }
            if (!(found instanceof Element)) return null;
            const existing = found.getAttribute('data-qz-field');
            if (existing) return existing;
            found.setAttribute('data-qz-field', nextId);
            return nextId;
          },
          xpath,
          candidateId,
        )
        .catch(() => null);
    }),
  );
}

/** 并行读取所有带标记控件的真实状态，不滚动页面；原生下拉附带选项文字。支持跨 iframe 汇总。 */

export async function readTaggedControls(
  driver: PageDriver,
): Promise<Map<string, FormControlState & { options?: string[] }>> {
  const result = new Map<string, FormControlState & { options?: string[] }>();
  if (!driver.puppeteer) return result;
  await driver.checkTarget();
  const handleGroups = await Promise.all(
    allSearchContexts(driver).map(ctx =>
      typeof ctx.$$ === 'function' ? ctx.$$('[data-qz-field]').catch(() => []) : Promise.resolve([]),
    ),
  );
  const handles = handleGroups.flat();
  await Promise.all(
    handles.map(async handle => {
      try {
        const [id, state, options] = await Promise.all([
          handle.evaluate(el => el.getAttribute('data-qz-field') ?? ''),
          readLiveControl(handle, false),
          handle.evaluate(el =>
            el.tagName === 'SELECT'
              ? Array.from((el as HTMLSelectElement).options, option => option.text.trim())
              : null,
          ),
        ]);
        if (id) result.set(id, options ? { ...state, options } : state);
      } catch {
        /* 读取途中被移除的控件不计入。 */
      } finally {
        await handle.dispose();
      }
    }),
  );
  return result;
}

/** display：字段是从列表或面板选出来的，读控件框里显示的值。 */

export async function readApplicationControl(driver: PageDriver, node: DOMElementNode, display = false) {
  const { element } = await applicationControl(driver, node);
  return readLiveControl(element, display);
}

/** 侧栏定位只滚动和高亮，不点击、不改值。调用方必须先重新核对字段身份。 */

export async function revealApplicationControl(driver: PageDriver, node: DOMElementNode): Promise<void> {
  const element = await driver.page.locateElement(node);
  if (!element) throw new Error('字段已变化，请重新检查表单。');
  try {
    await driver.reveal(element);
  } finally {
    await element.dispose();
  }
}
