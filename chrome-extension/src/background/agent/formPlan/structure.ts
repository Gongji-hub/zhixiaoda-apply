import type { z } from 'zod';
import { needsUserInteraction } from '../actions/interactionPolicy';
import { waitForApplicationDialog } from '../applicationDialog';
import type { DOMElementNode } from '../../browser/dom/views';
import { URLNotAllowedError } from '../../browser/views';
import { Actors, ExecutionState } from '../event/types';
import type { AgentContext } from '../types';
import { writeApplicationField } from '../writeApplicationField';
import { waitForApplicationResume, type FormOutline, type OutlineButton, type OutlineField } from './outline';
import { readOutlineWithOptions, type structureSchema, type Run } from './planContext';

async function click(run: Run, outline: FormOutline, id: string): Promise<boolean> {
  const button = outline.buttons.get(id);
  if (!button || needsUserInteraction(button.node, 'open_interface')) return false;
  const page = await run.context.browserContext.getCurrentPage();
  await page.clickElementNode(false, button.node, run.context.controller.signal);
  return true;
}

export async function toggle(run: Run, field: OutlineField, desired: boolean): Promise<void> {
  if ((field.value === 'true') === desired) return;
  const page = await run.context.browserContext.getCurrentPage();
  const result = await writeApplicationField(run.context, page, {
    field: field.field,
    node: field.node,
    value: String(desired),
    method: 'check',
    policy: 'never',
    observedValue: field.value,
  });
  await run.record(run.context, result, field.field, String(desired), field.required);
  if (result.status === 'failed')
    run.problems.set(field.id, {
      id: field.id,
      label: field.label,
      value: String(desired),
      reason: `${result.code}: ${result.message}`,
    });
}

/** 按区块核对结果取消隐藏、补足段数；返回是否做了改动。 */
/** 每个区块第一次核对时的段数和代码已点添加的次数：后面轮次模型少数时不再多加。 */
export type Tally = Map<string, { base: number; added: number }>;

export type Section = z.infer<typeof structureSchema>['sections'][number];
export const heading = (text: string) => text.trim().replace(/^·\s+/u, '').replace(/\s+/g, '').replace(/[*：:]$/g, '');
function isSplitWorkSectionConfirmedEmpty(context: AgentContext, title: string, sections: Section[]): boolean {
  const task = context.applicationTask ?? '';
  const snapshot = task.match(/<resume_evidence>([\s\S]*?)<\/resume_evidence>/)?.[1] ?? task;
  if (!snapshot) return false;
  try {
    const parsed = JSON.parse(snapshot) as {
      profile?: {
        work?: Array<{ employment_type?: string; include_in_application?: boolean }>;
        applicationInfo?: {
          work?: Array<{ employment_type?: string; include_in_application?: boolean }>;
        };
      };
    };
    const rawWork = parsed?.profile?.applicationInfo?.work ?? parsed?.profile?.work;
    if (!Array.isArray(rawWork)) return false;
    const active = rawWork.filter(item => item?.include_in_application !== false);
    if (!active.length) return false;
    const isInternshipTitle = /实习|intern/i.test(title) && !/工作/.test(title);
    if (isInternshipTitle && active.every(item => item?.employment_type === 'full_time')) return true;
    const isFullTimeTitle =
      /工作|work/i.test(title) &&
      !/实习|intern/i.test(title) &&
      sections.some(other => /实习|intern/i.test(other.title) && !/工作/.test(other.title));
    if (isFullTimeTitle && active.every(item => item?.employment_type === 'internship')) return true;
  } catch {
    /* Non-JSON task strings fall back to empty_confirmed from structure decision. */
  }
  return false;
}

export function sectionItems(outline: FormOutline, section: Section, sections: Section[]) {
  const start = outline.items.findIndex(item => item.type === 'text' && heading(item.text) === heading(section.title));
  if (start < 0) return null;
  const rest = outline.items.slice(start + 1);
  const end = rest.findIndex(
    item => item.type === 'text' && sections.some(other => heading(other.title) === heading(item.text)),
  );
  return end < 0 ? rest : rest.slice(0, end);
}

/** React may replace the add button after every click. Resolve its new identity inside the same section. */
function refreshedButton(
  outline: FormOutline,
  section: Section,
  sections: Section[],
  original?: OutlineButton,
): OutlineButton | undefined {
  if (!original) return undefined;
  const current = outline.buttons.get(original.id);
  if (current) return current;
  const scoped = sectionItems(outline, section, sections);
  const candidates = (scoped ?? [])
    .filter((item): item is OutlineButton => item.type === 'button')
    .filter(item => item.text === original.text && item.hint === original.hint);
  if (candidates.length === 1) return candidates[0];
  // Without an identifiable heading, only an explicit, unique DOM id can establish identity.
  const domId = original.node.attributes.id;
  const identified = [...outline.buttons.values()].filter(
    item => domId && item.node.attributes.id === domId && item.text === original.text,
  );
  return identified.length === 1 ? identified[0] : undefined;
}

export async function applyStructure(
  run: Run,
  outline: FormOutline,
  sections: z.infer<typeof structureSchema>['sections'],
  revealed: Set<string>,
  tally: Tally,
  probeSection?: Section,
): Promise<{ outline: FormOutline; changed: boolean }> {
  let changed = false;
  for (const section of sections) {
    const button = outline.buttons.get(section.add_button ?? '');
    if (button) run.sectionAddButtons.set(heading(section.title), button);
  }
  for (const section of sections) {
    if (probeSection ? section !== probeSection : section.optional_rows && !section.reveal_toggle) continue;
    await waitForApplicationResume(run.context);
    const reveal = section.reveal_toggle ? outline.fields.get(section.reveal_toggle) : undefined;
    const scopedFields = (sectionItems(outline, section, sections) ?? []).filter(
      (item): item is OutlineField => item.type === 'field' && item.id !== section.reveal_toggle,
    );
    const hasExistingContent = scopedFields.some(
      f => !['checkbox', 'radio', 'switch'].includes(f.kind) && f.value.trim() !== '',
    );
    if (reveal && ['checkbox', 'switch'].includes(reveal.kind)) {
      if (section.needed > 0 || hasExistingContent) {
        run.resolvedRevealToggles.add(reveal.field.key);
        if (reveal.value === 'true') {
          await run.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, `正在展开 · ${section.title}`);
          await waitForApplicationResume(run.context);
          await toggle(run, reveal, false);
          outline = await readOutlineWithOptions(run);
          revealed.add(section.reveal_toggle!).add(section.title);
          changed = true;
          continue; // 展开后的段落和添加按钮下一轮再核对。
        }
      } else if (section.needed === 0) {
        if (reveal.value === 'true') {
          run.resolvedRevealToggles.add(reveal.field.key);
          continue;
        }
        if (
          section.empty_confirmed === true ||
          isSplitWorkSectionConfirmedEmpty(run.context, section.title, sections)
        ) {
          await run.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, `正在勾选 · ${reveal.label}`);
          await waitForApplicationResume(run.context);
          await toggle(run, reveal, true);
          outline = await readOutlineWithOptions(run);
          if (outline.fields.get(reveal.id)?.value === 'true' || !run.problems.has(reveal.id)) {
            run.resolvedRevealToggles.add(reveal.field.key);
            run.written.add(reveal.id);
          }
          changed = true;
          continue;
        }
      }
    }
    // 刚展开的区块至少已有展开出来的那一段，模型漏数时按 1 计，避免多加空段。
    const justRevealed =
      revealed.has(section.title) || (section.reveal_toggle !== null && revealed.has(section.reveal_toggle));
    const count = tally.get(section.title) ?? {
      base: justRevealed ? Math.max(section.existing, 1) : section.existing,
      added: 0,
    };
    tally.set(section.title, count);
    const existing = Math.max(section.existing, count.base + count.added, justRevealed ? 1 : 0);
    const missing = Math.min(section.needed - existing, probeSection ? 1 : 8);
    run.structureProblems.delete(section.title);
    if (missing <= 0 || (section.optional_rows && !probeSection)) continue;
    let remaining = section.needed - existing;
    if (!probeSection) run.structureProblems.set(
      section.title,
      `${section.title}：需要 ${section.needed} 段，已确认 ${existing} 段，还缺 ${remaining} 段。`,
    );
    if (!section.add_button && !section.add_text) continue;
    const page = await run.context.browserContext.getCurrentPage();
    for (let i = 0; i < missing; i++) {
      await waitForApplicationResume(run.context);
      await run.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, `正在补充区块 · ${section.title}`);
      await waitForApplicationResume(run.context);
      const button = refreshedButton(outline, section, sections, run.sectionAddButtons.get(heading(section.title)));
      const beforeIds = new Set(outline.fields.keys());
      const beforeButtonIds = new Set(outline.buttons.keys());
      const before = (sectionItems(outline, section, sections) ?? [...outline.fields.values()]).filter(
        item => item.type === 'field',
      ).length;
      let clicked: boolean;
      try {
        clicked = section.add_button
          ? Boolean(button && (await click(run, outline, button.id)))
          : await page.clickApplicationText(section.add_text!, section.title, run.context.controller.signal);
      } catch (error) {
        run.context.controller.signal.throwIfAborted();
        if (error instanceof URLNotAllowedError) throw error;
        run.structureProblems.set(section.title, `${section.title}：添加入口点击失败，请核对该区块。`);
        run.context.trace?.('整页填写 · 添加失败', 0, `${section.title}：${error instanceof Error ? error.message : String(error)}`);
        outline = await readOutlineWithOptions(run);
        break;
      }
      if (!clicked) {
        if (probeSection) run.structureProblems.set(section.title, `${section.title}：找不到添加入口，请在页面核对。`);
        run.context.trace?.(
          '整页填写 · 添加失败',
          0,
          `${section.title}：没找到可点击的「${section.add_button ?? section.add_text}」`,
        );
        break;
      }
      let grew = false;
      for (let poll = 0; poll < 3; poll++) {
        if (poll) await new Promise(resolve => setTimeout(resolve, 150));
        await waitForApplicationResume(run.context);
        outline = await readOutlineWithOptions(run);
        const after = (sectionItems(outline, section, sections) ?? [...outline.fields.values()]).filter(
          item => item.type === 'field',
        ).length;
        if (after > before) {
          grew = true;
          break;
        }
      }
      if (!grew) {
        if (probeSection) run.structureProblems.set(section.title, `${section.title}：打开添加入口后未识别到新增字段，请核对页面。`);
        run.context.trace?.('整页填写 · 添加失败', 0, `${section.title}：点击后未观察到新增字段，未计为新增成功。`);
        break;
      }
      const sectionKey = heading(section.title);
      const record = run.addedSections.get(sectionKey) ?? { fieldIds: new Set<string>(), buttonIds: new Set<string>() };
      run.addedSections.set(sectionKey, record);
      const scoped = sectionItems(outline, section, sections) ?? outline.items;
      for (const { id } of scoped.filter((item): item is OutlineField => item.type === 'field')) {
        if (!beforeIds.has(id)) {
          run.addedFieldIds.add(id);
          record.fieldIds.add(id);
        }
      }
      for (const { id } of scoped.filter((item): item is OutlineButton => item.type === 'button')) {
        if (!beforeButtonIds.has(id)) {
          record.buttonIds.add(id);
        }
      }
      count.added++;
      remaining--;
      if (!probeSection && remaining > 0)
        run.structureProblems.set(
          section.title,
          `${section.title}：需要 ${section.needed} 段，已确认 ${section.needed - remaining} 段，还缺 ${remaining} 段。`,
        );
      else run.structureProblems.delete(section.title);
      changed = true;
    }
  }
  return { outline, changed };
}

const OPTIONAL_ADDED_SECTION_RE =
  /社交|主页|个人链接|作品|自我评价|个人总结|竞赛|获奖|荣誉|论文|专利|social|portfolio|summary|award/i;
const CORE_EXPERIENCE_SECTION_RE = /教育|工作|实习|项目|education|work|intern|project/i;
const DELETE_BUTTON_RE = /删除|移除|delete|trash|remove|ashbin|bin|icon-delete|ic-delete/i;
const ADD_BUTTON_RE = /添加|新增|add|plus/i;

/** Require a row-local delete button before automatically confirming removal. */
function fieldsInRemovalGroup(outline: FormOutline, target: OutlineButton, row: OutlineField[]): OutlineField[] {
  const contains = (ancestor: DOMElementNode, node: DOMElementNode) => {
    for (let current: DOMElementNode | null = node; current; current = current.parent) {
      if (current === ancestor) return true;
    }
    return false;
  };
  const currentRow = row.map(field => outline.fields.get(field.id));
  if (!row.length || currentRow.some(field => !field)) return [];
  let group = target.node.parent;
  while (group && !currentRow.every(field => contains(group!, field!.node))) group = group.parent;
  return group ? [...outline.fields.values()].filter(field => contains(group!, field.node)) : [];
}

function ownsRemoval(outline: FormOutline, target: OutlineButton, row: OutlineField[]): boolean {
  if (!row.length) return false;
  return fieldsInRemovalGroup(outline, target, row).length === row.length;
}

function draftRemovalTarget(outline: FormOutline, before: FormOutline, buttonIds: Set<string>) {
  const candidates = [...buttonIds].flatMap(id => {
    const item = outline.buttons.get(id);
    if (!item || before.buttons.has(id) || item.node.tagName === 'a' && item.node.attributes.href) return [];
    const label = `${item.text} ${item.hint} ${item.node.attributes['aria-label'] ?? ''} ${item.node.attributes.title ?? ''}`;
    return DELETE_BUTTON_RE.test(label) && !ADD_BUTTON_RE.test(label) ? [item] : [];
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function completeDraftFields(outline: FormOutline, before: FormOutline, row: OutlineField[], buttonIds: Set<string>) {
  const target = draftRemovalTarget(outline, before, buttonIds);
  if (!target) return row;
  const scoped = fieldsInRemovalGroup(outline, target, row);
  return scoped.length && scoped.every(field => !before.fields.has(field.id)) ? scoped : row;
}

export async function retractAddedRow(
  run: Run,
  outline: FormOutline,
  before: FormOutline,
  row: OutlineField[],
  buttonIds: Set<string>,
): Promise<FormOutline> {
  const target = draftRemovalTarget(outline, before, buttonIds);
  if (!target || !row.length || row.some(field => before.fields.has(field.id))) return outline;
  // The row's remove control belongs with the newly added fields, excluding any
  // current fields that predate the addition or belong to a different row.
  const ownsDraft = ownsRemoval(outline, target, row);
  if (target.node.parent && !ownsDraft) return outline;
  await waitForApplicationResume(run.context);
  if (await waitForApplicationDialog(run.context)) return readOutlineWithOptions(run);
  if (!(await click(run, outline, target.id))) return outline;
  // Confirmation belongs to the exact temporary row we just requested to remove.
  await waitForApplicationDialog(run.context, ownsDraft ? target.node : undefined);
  for (let poll = 0; poll < 3; poll++) {
    if (poll) await new Promise(resolve => setTimeout(resolve, 150));
    await waitForApplicationResume(run.context);
    outline = await readOutlineWithOptions(run);
    if (row.every(field => !outline.fields.has(field.id))) break;
  }
  for (const field of row) {
    if (outline.fields.has(field.id)) continue;
    run.asks.delete(field.id);
    run.problems.delete(field.id);
    run.written.delete(field.id);
    run.preserved.delete(field.id);
    run.loadedOptions.delete(field.id);
    run.context.review.removeField(field.field);
  }
  return outline;
}

/** Retract optional '+ 添加' blocks that we expanded from 0 rows if they could not be cleanly populated. */
export async function retractUnfillableAddedSections(
  run: Run,
  outline: FormOutline,
  sections: Section[],
  tally: Tally,
): Promise<FormOutline> {
  const matchesDeleteBtn = (btn: OutlineButton, section: Section) => {
    if (btn.id === section.add_button) return false;
    const meta = `${btn.text} ${btn.hint} ${btn.node.attributes['aria-label'] ?? ''} ${btn.node.attributes.title ?? ''} ${btn.node.attributes.class ?? ''}`;
    return !ADD_BUTTON_RE.test(`${btn.text} ${btn.hint}`) && DELETE_BUTTON_RE.test(meta);
  };
  for (const [title, count] of tally) {
    if (count.base !== 0 || count.added <= 0) continue;
    const sectionKey = heading(title);
    const section = sections.find(item => heading(item.title) === sectionKey);
    if (!section || section.reveal_toggle || section.optional_rows) continue;
    if (!OPTIONAL_ADDED_SECTION_RE.test(title) || CORE_EXPERIENCE_SECTION_RE.test(title)) continue;
    const rawScoped = sectionItems(outline, section, sections) ?? [];
    const firstPreExistingIdx = rawScoped.findIndex(
      item => item.type === 'field' && run.preExistingFieldIds.has(item.id),
    );
    const scoped = firstPreExistingIdx < 0 ? rawScoped : rawScoped.slice(0, firstPreExistingIdx);
    const record = run.addedSections.get(sectionKey);
    const recordedFields = record
      ? [...record.fieldIds].map(id => outline.fields.get(id)).filter((f): f is OutlineField => Boolean(f))
      : [];
    const scopedFields = recordedFields.length
      ? recordedFields
      : scoped.filter((item): item is OutlineField => item.type === 'field' && !run.preExistingFieldIds.has(item.id));
    if (!scopedFields.length) continue;
    const anyPopulated = scopedFields.some(
      f =>
        !['checkbox', 'radio', 'switch'].includes(f.kind) &&
        f.value.trim() !== '' &&
        f.valid &&
        f.selectionConfirmed !== false,
    );
    const hasUnresolvedRequired = scopedFields.some(
      f =>
        f.required &&
        (!f.value.trim() || !f.valid || f.selectionConfirmed === false || run.problems.has(f.id) || run.asks.has(f.id)),
    );
    if (anyPopulated && !hasUnresolvedRequired) continue;
    const recordedDeleteBtn = record
      ? [...record.buttonIds]
          .map(id => outline.buttons.get(id))
          .find((btn): btn is OutlineButton => btn !== undefined && matchesDeleteBtn(btn, section))
      : undefined;
    const deleteBtn =
      recordedDeleteBtn ??
      scoped
        .filter((item): item is OutlineButton => item.type === 'button')
        .find(btn => matchesDeleteBtn(btn, section));
    if (!deleteBtn) continue;
    await waitForApplicationResume(run.context);
    if (await waitForApplicationDialog(run.context)) {
      outline = await readOutlineWithOptions(run);
      continue;
    }
    const clicked = await click(run, outline, deleteBtn.id);
    if (!clicked) continue;
    const ownsDraft = recordedDeleteBtn === deleteBtn && scopedFields.every(field => !run.preExistingFieldIds.has(field.id)) &&
      ownsRemoval(outline, deleteBtn, scopedFields);
    await waitForApplicationDialog(run.context, ownsDraft ? deleteBtn.node : undefined);
    for (let poll = 0; poll < 3; poll++) {
      if (poll) await new Promise(resolve => setTimeout(resolve, 150));
      await waitForApplicationResume(run.context);
      outline = await readOutlineWithOptions(run);
      const remainingAdded = scopedFields.filter(f => outline.fields.has(f.id)).length;
      if (remainingAdded < scopedFields.length) break;
    }
    let removedAny = false;
    for (const f of scopedFields) {
      if (!outline.fields.has(f.id)) {
        removedAny = true;
        run.asks.delete(f.id);
        run.problems.delete(f.id);
        run.written.delete(f.id);
        run.preserved.delete(f.id);
        run.context.review.removeField(f.field);
      }
    }
    if (removedAny) {
      run.context.trace?.('整页填写 · 撤回选填区块', 0, title);
    }
  }
  return outline;
}
