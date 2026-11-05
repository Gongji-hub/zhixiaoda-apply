import '../../public/job-panel/progress-copy.js';

export function actionProgress(value: string): { title: string; detail: string } {
  return (globalThis as unknown as {
    JobApplyProgressCopy: { actionProgress(value: string): { title: string; detail: string } };
  }).JobApplyProgressCopy.actionProgress(value);
}
