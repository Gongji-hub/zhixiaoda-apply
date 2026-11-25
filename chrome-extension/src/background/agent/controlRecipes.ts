import type { UnknownObservation } from '../browser/unknownControlDom';
import { formValuesEquivalent } from '../browser/formFill';
import { sitePatternKey } from './formPlan/siteFieldCache';

/**
 * Operation records for special controls, kept per site in this browser only.
 * A model exploration that ended verified is replayed deterministically the next time
 * the same site shows the same field; every replay is re-verified, and any mismatch
 * deletes the record and hands the field back to model exploration.
 * Steps that targeted the requested value store no text; other option texts are
 * stored literally (e.g. the parent "中国" of "北京") and never leave local storage.
 */
const STORAGE_KEY = 'jobAgentControlRecipes';
const MAX_SITES = 50;
const MAX_RECIPES_PER_SITE = 40;
const MAX_STEPS = 8;
const MAX_TEXT = 60;
/** After this many verified replays the trace suggests turning the record into an adapter. */
export const ADAPTER_CANDIDATE_USES = 3;

type Target = UnknownObservation['targets'][number];
export interface RecipeStep {
  action: 'click' | 'type' | 'scroll';
  region: Target['region'];
  tag: string;
  role: string;
  /** Literal target text; null when the step used the requested value itself. */
  text: string | null;
}
export interface ControlRecipe {
  label: string;
  steps: RecipeStep[];
  uses: number;
  updatedAt: number;
}
interface RecipeStore {
  sites: Record<string, { updatedAt: number; recipes: Record<string, ControlRecipe> }>;
}

let memoryStore: RecipeStore | null = null;
let memoryOnly = false;

/** Tests and the component lab keep records in memory instead of chrome.storage. */
export function useMemoryRecipeStoreForTest(): void {
  memoryOnly = true;
  memoryStore = { sites: {} };
}

function chromeStorage(): typeof chrome.storage.local | null {
  if (memoryOnly) return null;
  return typeof chrome !== 'undefined' && typeof chrome.storage?.local?.get === 'function' ? chrome.storage.local : null;
}

/** Without extension storage (unit tests) nothing is kept unless a test opts in,
 * so one test's record can never change another test's exploration. */
async function readStore(): Promise<RecipeStore | null> {
  const storage = chromeStorage();
  if (!storage && !memoryOnly) return null;
  if (storage) {
    try {
      const raw = (await storage.get(STORAGE_KEY))?.[STORAGE_KEY] as RecipeStore | undefined;
      if (raw && typeof raw === 'object' && raw.sites && typeof raw.sites === 'object') return (memoryStore = raw);
    } catch {
      /* Fall back to the in-memory copy. */
    }
  }
  return (memoryStore ??= { sites: {} });
}

async function writeStore(store: RecipeStore): Promise<void> {
  const sites = Object.entries(store.sites);
  if (sites.length > MAX_SITES)
    sites.sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(MAX_SITES).forEach(([key]) => delete store.sites[key]);
  memoryStore = store;
  try {
    await chromeStorage()?.set({ [STORAGE_KEY]: store });
  } catch {
    /* Quota or permission errors only lose the shortcut, never a fill result. */
  }
}

const recipeKey = (label: string) => label.replace(/\s+/g, ' ').trim();

export async function findControlRecipe(url: string | undefined, label: string): Promise<ControlRecipe | null> {
  if (!url) return null;
  const site = (await readStore())?.sites[sitePatternKey(url)];
  return site?.recipes[recipeKey(label)] ?? null;
}

/** Build the record from executed steps; refuse anything that cannot be replayed exactly. */
export function recipeSteps(
  performed: Array<{ action: RecipeStep['action']; target: Target }>,
  desired: string,
): RecipeStep[] | null {
  if (!performed.length || performed.length > MAX_STEPS) return null;
  const steps = performed.map(({ action, target }) => {
    const fromValue = action === 'type' || formValuesEquivalent(target.text.trim(), desired);
    return { action, region: target.region, tag: target.tag, role: target.role, text: fromValue ? null : target.text.trim() };
  });
  return steps.every(step => step.text === null || (step.text.length > 0 && step.text.length <= MAX_TEXT)) ? steps : null;
}

export async function saveControlRecipe(url: string | undefined, label: string, steps: RecipeStep[]): Promise<void> {
  const store = url ? await readStore() : null;
  if (!url || !store) return;
  const key = sitePatternKey(url);
  const site = (store.sites[key] ??= { updatedAt: Date.now(), recipes: {} });
  site.updatedAt = Date.now();
  site.recipes[recipeKey(label)] = { label, steps, uses: 0, updatedAt: Date.now() };
  const recipes = Object.entries(site.recipes);
  if (recipes.length > MAX_RECIPES_PER_SITE)
    recipes.sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(MAX_RECIPES_PER_SITE).forEach(([name]) => delete site.recipes[name]);
  await writeStore(store);
}

export async function markControlRecipe(url: string | undefined, label: string, replayed: boolean): Promise<number> {
  const store = url ? await readStore() : null;
  if (!url || !store) return 0;
  const site = store.sites[sitePatternKey(url)];
  const recipe = site?.recipes[recipeKey(label)];
  if (!site || !recipe) return 0;
  if (replayed) {
    recipe.uses++;
    recipe.updatedAt = site.updatedAt = Date.now();
  } else delete site.recipes[recipeKey(label)];
  await writeStore(store);
  return replayed ? recipe.uses : 0;
}

/** The single observed target this step meant, or null when it is missing or ambiguous. */
export function recipeTarget(step: RecipeStep, observation: UnknownObservation, desired: string): Target | null {
  const matches = observation.targets.filter(
    target =>
      target.region === step.region &&
      target.tag === step.tag &&
      target.role === step.role &&
      (step.text === null
        ? step.action === 'type'
          ? target.editable
          : formValuesEquivalent(target.text.trim(), desired)
        : target.text.trim() === step.text),
  );
  return matches.length === 1 ? matches[0] : null;
}
