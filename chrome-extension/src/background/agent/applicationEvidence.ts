import type { AgentContext } from './types';

/** Every filling decision sees the launch facts and the same accepted, field-bound answers. */
export function applicationEvidence(context: AgentContext): string {
  const task = context.applicationTask ?? '';
  const snapshot = task.match(/<resume_evidence>([\s\S]*?)<\/resume_evidence>/)?.[1] ?? task;
  return JSON.stringify({ launchProfileAndResume: snapshot, acceptedAnswers: context.messageManager.getUserAnswers() });
}
