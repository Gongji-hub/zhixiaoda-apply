import { filterExternalContent } from './messages/utils';

/** Keep the last cause visible without exposing credentials or personal email. */
export function describeAgentFailure(stage: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = filterExternalContent(raw).replace(/\s+/g, ' ').trim().slice(0, 400);
  return `${stage}: ${detail || '未知错误'}`;
}
