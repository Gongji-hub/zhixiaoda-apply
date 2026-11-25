import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { URLNotAllowedError } from '../../browser/views';
import type { FormFieldReference } from '../formReview';
import type { Run } from './planContext';

export const equivalenceSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        equivalent: z.boolean(),
        reason: z.string().max(200),
      }),
    )
    .max(40),
});

export interface ReadbackDiff {
  id: string;
  field: FormFieldReference;
  label: string;
  intended: string;
  displayed: string;
  before: string;
  required: boolean;
}

/**
 * Third verification layer. The adapter's real value and the code-level format checks
 * (whitespace, dates, thousands groups, picker paths) already ran; what remains is a
 * different wording whose meaning only the Agent can judge, e.g. 北京 / 北京市 or a URL
 * with its scheme removed. Only fields our own write changed and the page shows stably
 * and validly reach here, all in one request. The verdict can confirm a field or keep
 * it for review; it never writes, rewrites or retries a value.
 */
export async function judgeReadbackDiffs(run: Run): Promise<void> {
  const { context } = run;
  const diffs = [...run.readbackDiffs.values()];
  if (!diffs.length || context.stopped) return;
  run.readbackDiffs.clear();
  let verdicts: z.infer<typeof equivalenceSchema>;
  try {
    verdicts = equivalenceSchema.parse(
      await run.llm.decide(
        'application_value_equivalence',
        [
          new HumanMessage(
            JSON.stringify({
              items: diffs.map(({ id, label, intended, displayed, before }) => ({ id, label, intended, displayed, before })),
            }),
          ),
        ],
        context.controller.signal,
      ),
    );
    run.calls++;
  } catch (error) {
    context.controller.signal.throwIfAborted();
    if (error instanceof URLNotAllowedError) throw error;
    // An older service without this stage keeps the fields in the review list as before.
    context.trace?.('写法核对 · 未完成', 0, error instanceof Error ? error.message : '判断服务暂时不可用。');
    return;
  }
  let confirmed = 0;
  for (const verdict of verdicts.items) {
    const diff = diffs.find(item => item.id === verdict.id);
    if (!diff) continue;
    if (!verdict.equivalent) {
      const entry = context.review.entry(diff.field);
      if (entry) entry.message = `网页显示为「${diff.displayed}」，与拟填写的「${diff.intended}」不是同一内容：${verdict.reason}`;
      continue;
    }
    confirmed++;
    await run.record(
      context,
      {
        status: 'verified',
        code: 'EQUIVALENT_READBACK',
        message: `网页显示为「${diff.displayed}」，已确认与「${diff.intended}」表达同一内容。`,
        adapter: 'readback-equivalence',
        attempts: 1,
        actualValue: diff.displayed,
        desiredValue: diff.intended,
      },
      diff.field,
      diff.intended,
      diff.required,
    );
    run.written.add(diff.id);
  }
  context.trace?.('写法核对', 0, `判定 ${diffs.length} 项，确认等同 ${confirmed} 项`);
}
