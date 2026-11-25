import { formValuesEquivalent } from '../../browser/formFill';
import { URLNotAllowedError } from '../../browser/views';
import { ApplicationDialogPending } from '../applicationDialog';
import { applyValues } from './applyValues';
import { loadDropdownOptions, type FormOutline, type OutlineField } from './outline';
import { plan, prompt, readOutlineWithOptions, valuesSchema, type Run } from './planContext';
import { applyStructure, completeDraftFields, heading, retractAddedRow, sectionItems, type Tally } from './structure';

async function inspectOptions(run: Run, outline: FormOutline, ids: Set<string>) {
  if (!ids.size) return;
  await loadDropdownOptions(run.context, outline, ids);
  run.context.controller.signal.throwIfAborted();
  for (const id of ids) {
    const options = outline.fields.get(id)?.options;
    if (options?.length) run.loadedOptions.set(id, options);
  }
}

export async function inspectExistingOptionalRows(run: Run, outline: FormOutline): Promise<void> {
  const ids = new Set<string>();
  for (const section of run.sections) {
    if (!section.optional_rows || section.needed <= 0) continue;
    for (const item of sectionItems(outline, section, run.sections) ?? []) {
      if (item.type === 'field') ids.add(item.id);
    }
  }
  await inspectOptions(run, outline, ids);
}

const accepted = (field: OutlineField) =>
  field.valueKnown && field.value.trim() !== '' && field.valid && field.selectionConfirmed !== false;

interface OptionalDraft {
  section: string;
  before: FormOutline;
  fields: OutlineField[];
  removeIds: Set<string>;
}

function rowValues(fields: OutlineField[]) {
  return JSON.stringify(fields.filter(accepted).map(field => [
    field.label.replace(/\s*[（(]\d+\s*\/\s*\d+[）)]$/, '').replace(/^[*＊\s]+|[：:*＊\s]+$/gu, ''),
    field.value.trim().replace(/\s+/g, ' '),
  ]).sort((a, b) => a[0].localeCompare(b[0])));
}

/** Discover the real controls in one draft row, then commit it or roll it back before adding another. */
export async function fillOptionalRows(
  run: Run, outline: FormOutline, revealed: Set<string>, tally: Tally,
): Promise<{ outline: FormOutline; retained: OptionalDraft[] }> {
  const retained: OptionalDraft[] = [];
  for (const section of run.sections) {
    if (!section.optional_rows || section.needed <= section.existing || run.context.stopped) continue;
    const key = heading(section.title);
    const clues = (section.row_evidence ?? []).filter(item => item.source.trim() && run.evidence.includes(item.source));
    for (let round = 0; round < Math.min(section.needed - section.existing, 8) && !run.context.stopped; round++) {
      const before = await readOutlineWithOptions(run);
      // The addition discovers the editable fields and the row's own remove control together.
      const result = await applyStructure(run, before, run.sections, revealed, tally, section);
      outline = result.outline;
      if (!result.changed) break;
      const added = run.addedSections.get(key);
      if (!added) break;
      const removeIds = new Set([...added.buttonIds].filter(id => !before.buttons.has(id) && outline.buttons.has(id)));
      const originals = new Map([...outline.fields.values()]
        .filter(field => added.fieldIds.has(field.id) && !before.fields.has(field.id))
        .map(field => [field.id, field]));
      if (!originals.size) {
        run.structureProblems.set(section.title, `${section.title}：添加后未能确认临时行，请核对页面。`);
        break;
      }
      let committed = false;
      let draft = [...originals.values()];
      try {
        // A choice can reveal dependent fields in this row. Inspect one fresh
        // pass before committing, including the new fields in the rollback.
        for (let pass = 0; pass < 2; pass++) {
          const ids = new Set(draft.filter(field => !accepted(field)).map(field => field.id));
          if (!ids.size) break;
          await inspectOptions(run, outline, ids);
          const proposal = await plan(
            run, valuesSchema, '填写方案', prompt(run, outline,
            `可撤回的选填区块「${section.title}」刚加了一行。本次只规划这一行的待填字段 ${[...ids].join('、')}。先看实际选项和格式；同一行的值必须来自同一条真实资料，整行不得和已有行重复。所有必填项都应有值；所有候选都无法填齐时返回空 values 和空 ask。URL 可沿用资料里的域名和路径，协议仅按网页明确的格式要求处理。
结构规划已找到的资料线索（仍须结合完整资料和可用选项判断）：${JSON.stringify(clues)}`),
          );
          const writes = proposal.values.filter(item => ids.has(item.id) && !item.ai_inferred && item.value.trim());
          if (!writes.length || draft.some(
            field => field.required && !accepted(field) && !writes.some(item => item.id === field.id),
          )) break;
          await applyValues(run, outline, writes);
          // Category choices may mount the detail inputs after the first read.
          if (draft.some(field => ids.has(field.id) && ['select', 'combobox'].includes(field.kind))) {
            await new Promise(resolve => setTimeout(resolve, 180));
          }
          outline = await readOutlineWithOptions(run);
          if ([...originals.keys()].some(id => !outline.fields.has(id))) break;
          const scope = sectionItems(outline, section, run.sections) ?? [];
          const previousSize = originals.size;
          for (const item of scope) {
            if (item.type === 'field' && !before.fields.has(item.id) && !originals.has(item.id)) originals.set(item.id, item);
          }
          draft = [...originals.keys()].map(id => outline.fields.get(id)!);
          if (draft.every(field => !field.required || accepted(field)) && draft.some(field => run.written.has(field.id))) {
            retained.push({ section: section.title, before, fields: draft, removeIds });
            committed = true;
            break;
          }
          if (originals.size === previousSize) break;
        }
      } catch (error) {
        run.context.controller.signal.throwIfAborted();
        if (error instanceof URLNotAllowedError || error instanceof ApplicationDialogPending) throw error;
        run.context.trace?.('整页填写 · 临时行未完成', 0, section.title);
      }

      if (committed) continue;
      outline = await readOutlineWithOptions(run);
      const originalFields = [...originals.values()];
      const unchangedByUser = originalFields.every(field => {
        const current = outline.fields.get(field.id);
        const recorded = run.context.review.entry(field.field);
        return current && (formValuesEquivalent(current.value, field.value) ||
          Boolean(recorded?.actualValue && formValuesEquivalent(current.value, recorded.actualValue)));
      });
      if (unchangedByUser) outline = await retractAddedRow(run, outline, before, originalFields, removeIds);
      const removed = originalFields.every(field => !outline.fields.has(field.id));
      if (removed) run.context.trace?.('整页填写 · 撤回临时行', 0, section.title);
      else run.structureProblems.set(section.title, `${section.title}：临时行未能撤回，请核对页面。`);
      // An unfillable draft means the plan has exhausted what it can add here.
      break;
    }
  }
  return { outline, retained };
}

/** Late reconciliation can make two initially different choices describe the same record. */
export async function retractDuplicateOptionalRows(run: Run, outline: FormOutline, retained: OptionalDraft[]) {
  if (retained.length < 2 || run.context.stopped) return outline;
  const seen = new Set<string>();
  for (const draft of retained) {
    const known = draft.fields.flatMap(field => {
      const current = outline.fields.get(field.id);
      return current ? [current] : [];
    });
    if (known.length !== draft.fields.length) continue;
    const row = completeDraftFields(outline, draft.before, known, draft.removeIds);
    if (!row.some(accepted) || row.some(field => field.required && !accepted(field))) continue;
    const signature = JSON.stringify([draft.section, rowValues(row)]);
    if (!seen.has(signature)) {
      seen.add(signature);
      continue;
    }
    const unchanged = row.every(field => {
      const written = run.context.review.entry(field.field)?.actualValue;
      const initial = draft.fields.find(item => item.id === field.id)?.value;
      return (initial !== undefined && formValuesEquivalent(field.value, initial)) ||
        (written !== undefined && formValuesEquivalent(field.value, written));
    });
    if (!unchanged) continue;
    outline = await retractAddedRow(run, outline, draft.before, row, draft.removeIds);
    if (row.every(field => !outline.fields.has(field.id))) {
      run.context.trace?.('整页填写 · 撤回重复临时行', 0, draft.section);
    } else {
      run.structureProblems.set(draft.section, `${draft.section}：存在重复的新增记录，请核对。`);
    }
  }
  return outline;
}
