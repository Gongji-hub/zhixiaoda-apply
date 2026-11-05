import '../../public/job-panel/site-policy.js';
export type Site = { url: string; origin: string; host: string; pattern: string };
export function siteFor(value: string): Site | null {
  return (globalThis as unknown as { JobApplySitePolicy: { siteFor(value: string): Site | null } }).JobApplySitePolicy.siteFor(value);
}
