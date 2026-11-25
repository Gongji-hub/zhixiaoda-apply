export const AUDIT_FINDING = 'INDEPENDENT_FORM_AUDIT';
export const AUDIT_INCOMPLETE = 'INDEPENDENT_FORM_AUDIT_INCOMPLETE';
/** A summary action must not impersonate a field's manual readback/retry action. */
export const INCOMPLETE_REVIEW_PREFIX = 'review-incomplete:';

/** Evidence behind a reminder, separate from whether an attempted action failed. */
export type ReviewIssue = 'missing' | 'invalid' | 'mismatch' | 'unverified';
export interface ReviewEvidence {
  key?: string;
  failureCode?: string;
  issue?: ReviewIssue;
}

export function reviewIssue(entry: ReviewEvidence): ReviewIssue | undefined {
  if (entry.issue) return entry.issue;
  // Compatibility for saved progress. Unclassified audit/transport failures
  // cannot establish that the applicant's value is wrong.
  if (['MISSING_INFORMATION', 'DATE_PRECISION_REQUIRED', 'OPTIONAL_MISSING'].includes(entry.failureCode ?? '')) return 'missing';
  if (entry.failureCode === 'VALIDATION_REJECTED') return 'invalid';
  if (['VALUE_CHANGED', 'EXISTING_VALUE_PRESERVED'].includes(entry.failureCode ?? '')) return 'mismatch';
  if ([AUDIT_FINDING, AUDIT_INCOMPLETE, 'UNKNOWN_CONTROL_MANUAL', 'CONTROL_READ_FAILED',
    'VERIFY_FAILED', 'SELECTION_UNCONFIRMED'].includes(entry.failureCode ?? '')) return 'unverified';
  return undefined;
}

export function isIncompleteAudit(entry: ReviewEvidence): boolean {
  return entry.failureCode === AUDIT_INCOMPLETE ||
    reviewIssue(entry) === 'unverified';
}
