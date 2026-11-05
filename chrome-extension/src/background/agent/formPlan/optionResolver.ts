import { z } from 'zod';
import { HumanMessage } from '@langchain/core/messages';
import type { DecisionClient } from '../../decisionClient';
import type { AgentContext } from '../types';
import { applicationEvidence } from '../applicationEvidence';
import { Actors, ExecutionState } from '../event/types';
import type { ApplicationControlOptions } from '../../browser/page';
import { waitForApplicationResume } from './outline';

export const choiceSchema = z.object({
  candidate: z.number().int().min(0).nullable(),
  reason: z.string(),
});

/** The model resolves meaning; the browser only locates the chosen real option and verifies the write. */
export function optionResolver(context: AgentContext, llm: DecisionClient, label: string, onCall?: () => void): NonNullable<ApplicationControlOptions['resolveOption']> {
  return async evidence => {
    await waitForApplicationResume(context);
    await context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, `正在判断候选 · ${label}`);
    const started = Date.now();
    onCall?.();
    const resume = applicationEvidence(context);
    const parsed = await llm.decide('application_option_choice', [
      new HumanMessage(JSON.stringify({ field: label, ...evidence,
        candidates: evidence.candidates.map((text, candidate) => ({ candidate, text })), resume })),
    ], context.controller.signal);
    const choice = choiceSchema.parse(parsed);
    await waitForApplicationResume(context);
    if (choice.candidate !== null && choice.candidate >= evidence.candidates.length) throw new Error('候选判断返回了不存在的选项。');
    const selected = choice.candidate === null ? null : evidence.candidates[choice.candidate];
    context.trace?.('候选判断', Date.now() - started, `${label}：${selected === null ? '无法确定合适候选' : `「${evidence.requested}」→「${selected}」`}；${choice.reason}`);
    return selected;
  };
}
