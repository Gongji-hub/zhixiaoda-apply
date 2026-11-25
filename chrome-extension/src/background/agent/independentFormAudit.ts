import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { DecisionClient } from '../decisionClient';
import { confirmedAuditControl, type AuditSnapshot } from '../browser/formAudit';
import { formValuesEquivalent } from '../browser/formFill';
import type { AgentContext } from './types';
import { Actors, ExecutionState } from './event/types';
import { AUDIT_FINDING, AUDIT_INCOMPLETE } from '../auditStatus';

export const formAuditSchema = z.object({
  reviewed_ids: z.array(z.string()),
  findings: z
    .array(
      z.object({
        anchor: z.string(),
        label: z.string().min(1).max(120),
        required: z.boolean().nullable(),
        status: z.enum(['missing', 'invalid', 'uncertain']),
        reason: z.string().min(1).max(400),
        evidence: z.string().min(1).max(300),
      }),
    )
    .max(80),
  unverifiable: z.array(z.string().min(1).max(300)).max(20),
});
type AuditResult = z.infer<typeof formAuditSchema>;
const cache = new WeakMap<AgentContext, { signature: string; result?: AuditResult; error?: string }>();
const running = new WeakSet<AgentContext>();

/** A separate, read-only observation path. It neither reuses the fill inventory nor repairs/submits the form. */
export async function auditCompletedForm(context: AgentContext, llm: DecisionClient, force = false): Promise<void> {
  if (!context.options.targetOrigin) return;
  if (running.has(context)) throw new Error('独立核查正在进行，请稍候。');
  const parent = force ? new AbortController().signal : context.controller.signal;
  parent.throwIfAborted();
  running.add(context);
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', abort, { once: true });
  let rejectAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new Error('独立核查超时，尚不能确认整张表已填写完整。')), 30_000);
  const bounded = async <T>(work: () => Promise<T>) => {
    controller.signal.throwIfAborted();
    const result = await Promise.race([work(), cancelled]);
    controller.signal.throwIfAborted();
    return result;
  };
  let url = '';

  let snapshot: AuditSnapshot | undefined;
  let signature = '';
  try {
    url = (await bounded(() => context.browserContext.getCachedState()))?.url ?? '';
    await bounded(() => context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, '正在独立检查整张表的遗漏'));
    const page = await bounded(() => context.browserContext.getCurrentPage());
    await bounded(() => context.browserContext.assertApplyTarget(page.tabId));
    snapshot = await bounded(() => page.collectFormAudit(controller.signal));
    url = snapshot.url;
    signature = JSON.stringify(snapshot);
    const cached = cache.get(context);
    let result: AuditResult;
    if (!force && cached?.signature === signature) {
      if (cached.error) throw new Error(cached.error);
      result = cached.result!;
    } else {
      if (!snapshot.blocks.length) throw new Error('未读取到可独立核查的页面内容，请在网页核对后重新检查。');
      if (snapshot.blocks.length > 480) throw new Error('页面过长，本次独立核查未覆盖全部区域。');
      result = { reviewed_ids: [], findings: [], unverifiable: [...snapshot.gaps] };
      // Finite batches under one deadline, without model repair/retry loops.
      for (let offset = 0; offset < snapshot.blocks.length; offset += 80) {
        const blocks = snapshot.blocks.slice(offset, offset + 80);
        const raw = await bounded(() =>
          llm.decide(
            'application_form_audit',
            [
              new HumanMessage(
                JSON.stringify({
                  url,
                  blocks: blocks.map(({ id, text, controls }) => ({ id, text, controls })),
                }),
              ),
            ],
            controller.signal,
          ),
        );
        const part = formAuditSchema.parse(raw);
        const ids = new Set(blocks.map(block => block.id));
        if (
          part.reviewed_ids.length !== ids.size ||
          new Set(part.reviewed_ids).size !== ids.size ||
          part.reviewed_ids.some(id => !ids.has(id))
        )
          throw new Error('独立核查未覆盖本批全部区域，请在网页核对后重新检查。');
        const evidenceText = (text: string) => text.normalize('NFKC').replace(/\s+/g, '');
        for (const finding of part.findings) {
          const block = blocks.find(b => b.id === finding.anchor);
          // A rendered value (including an unchecked optional toggle) is evidence,
          // even when the component's internal search input is empty.
          if (block && finding.status !== 'invalid' && confirmedAuditControl(block)) continue;
          if (
            !block ||
            ![block.text, ...block.controls.flatMap(c => [c.label, c.value, c.placeholder, c.invalid])].some(text =>
              Boolean(evidenceText(finding.evidence)) && evidenceText(text).includes(evidenceText(finding.evidence)),
            )
          ) {
            const gap = '部分核查结果的位置或依据无法在网页确认。';
            if (!result.unverifiable.includes(gap)) result.unverifiable.push(gap);
            continue;
          }
          const control = block.controls.length === 1 ? block.controls[0] : undefined;
          if (control?.disabled || (finding.status === 'missing' && finding.required === false)) continue;
          if (finding.status === 'uncertain' ||
              (finding.status === 'missing' && finding.required !== true) ||
              ((control?.state === 'unknown' || control?.state === 'unconfirmed') &&
                !(finding.status === 'invalid' && control.invalid)) ||
              (finding.status === 'invalid' && control && control.state !== 'invalid' && !control.invalid)) {
            const gap = `「${finding.label}」未能完成检查，尚不能确认是否存在问题。`;
            if (!result.unverifiable.includes(gap)) result.unverifiable.push(gap);
            continue;
          }
          result.findings.push(finding);
        }
        result.reviewed_ids.push(...part.reviewed_ids);
        result.unverifiable.push(...part.unverifiable);
      }
      const fresh = await bounded(() => page.collectFormAudit(controller.signal));
      if (JSON.stringify(fresh) !== signature)
        throw new Error('核查期间页面内容发生变化，请重新检查，当前结果未采用。');
      cache.set(context, { signature, result });
    }
    controller.signal.throwIfAborted();
    // Replace only audit-owned reminders; ordinary fill history and user skips remain intact.
    for (const entry of context.review.snapshot())
      if (entry.url === url && [AUDIT_FINDING, AUDIT_INCOMPLETE].includes(entry.failureCode ?? '') && !context.review.isSkipped(entry))
        context.review.removeField(entry);
    // A directly verified control can clear a stale exploration reminder even
    // if other regions are still uncertain. The audit never restarts exploration.
    for (const entry of context.review.snapshot()) {
      if (entry.url !== url || entry.failureCode !== 'UNKNOWN_CONTROL_MANUAL' || context.review.isSkipped(entry))
        continue;
      const block = snapshot.blocks.find(
        b => b.location.anchor === entry.auditLocation?.anchor && b.location.frame === entry.auditLocation?.frame,
      );
      const confirmed = block ? confirmedAuditControl(block) : undefined;
      if (confirmed && (!entry.expectedValue.trim() || formValuesEquivalent(confirmed.value, entry.expectedValue))) {
        context.review.removeField(entry);
      } else if (
        force && !result.unverifiable.length &&
        ((!entry.auditLocation && !result.findings.length) ||
          (block && result.reviewed_ids.includes(block.id) && !result.findings.some(f => f.anchor === block.id)))
      ) {
        context.review.removeField(entry);
      }
    }
    for (const finding of result.findings) {
      const block = snapshot.blocks.find(b => b.id === finding.anchor)!;
      for (const entry of context.review.snapshot()) {
        if (entry.failureCode === 'UNKNOWN_CONTROL_MANUAL' && !context.review.isSkipped(entry) &&
            entry.auditLocation?.anchor === block.location.anchor && entry.auditLocation?.frame === block.location.frame)
          context.review.removeField(entry);
      }
      const field = {
        key: `audit:${url}:${finding.anchor}:${finding.label}`,
        label: finding.label,
        url,
        index: -1,
        auditLocation: block.location,
      };
      context.review.recordFailure(
        field,
        `${finding.reason}（页面依据：${finding.evidence}）。请定位到网页核对补充。`,
        finding.required === true,
        undefined,
        { failureCode: AUDIT_FINDING, autoDeferred: true, readOnly: true,
          issue: finding.status === 'missing' ? 'missing' : 'invalid' },
      );
    }
    if (result.unverifiable.length) recordIncomplete(context, url, [...new Set(result.unverifiable)].join('；'));
    context.trace?.(
      '独立遗漏核查',
      0,
      `检查 ${result.reviewed_ids.length} 个页面区域，发现 ${result.findings.length} 项，未确认区域 ${result.unverifiable.length} 处`,
    );
  } catch (error) {
    if (parent.aborted) throw error;
    const reason = error instanceof Error ? error.message : '独立核查未完成。';
    if (signature) cache.set(context, { signature, error: reason });
    recordIncomplete(context, url, reason);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', abort);
    running.delete(context);
    controller.signal.removeEventListener('abort', rejectAbort);
    controller.abort(new Error('独立核查已结束。'));
  }
  await context.emitEvent(Actors.SYSTEM, ExecutionState.REVIEW_UPDATED, JSON.stringify(context.review.snapshot()));
}

function recordIncomplete(context: AgentContext, url: string, message: string) {
  context.review.recordFailure(
    { key: `audit-incomplete:${url}`, label: '整张表的遗漏检查', url, index: -1 },
    message,
    true,
    undefined,
    { failureCode: AUDIT_INCOMPLETE, autoDeferred: true, readOnly: true },
  );
}
