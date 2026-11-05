import { z } from 'zod';
import { interactionEffects } from './interactionPolicy';

const effectSchema = z
  .enum(interactionEffects);

export interface ActionSchema {
  name: string;
  description: string;
  schema: z.ZodType;
}

export const doneActionSchema: ActionSchema = {
  name: 'done',
  description: '',
  schema: z.object({
    text: z.string(),
    success: z.boolean(),
  }),
};

// Basic Navigation Actions
export const searchGoogleActionSchema: ActionSchema = {
  name: 'search_google',
  description:
    '',
  schema: z.object({
    intent: z.string().default(''),
    query: z.string(),
  }),
};

export const goToUrlActionSchema: ActionSchema = {
  name: 'go_to_url',
  description: '',
  schema: z.object({
    intent: z.string().default(''),
    url: z.string(),
  }),
};

export const goBackActionSchema: ActionSchema = {
  name: 'go_back',
  description: '',
  schema: z.object({
    intent: z.string().default(''),
  }),
};

export const clickElementActionSchema: ActionSchema = {
  name: 'click_element',
  description: '',
  schema: z.object({
    effect: effectSchema,
    intent: z.string().default(''),
    index: z.number().int(),
    xpath: z.string().nullable().optional(),
  }),
};

export const inputTextActionSchema: ActionSchema = {
  name: 'input_text',
  description:
    '',
  schema: z.object({
    effect: effectSchema,
    intent: z.string().default(''),
    index: z.number().int(),
    text: z.string(),
    replace_existing: z
      .boolean()
      .optional(),
    xpath: z.string().nullable().optional(),
  }),
};

export const fillApplicationFormActionSchema: ActionSchema = {
  name: 'fill_application_form',
  description:
    '',
  schema: z.object({
    intent: z.string().default(''),
  }),
};

export const clickTextActionSchema: ActionSchema = {
  name: 'click_text',
  description:
    '',
  schema: z.object({
    intent: z.string().default(''),
    text: z.string().min(1),
    after: z.string().nullable().optional(),
    effect: effectSchema,
  }),
};

export const pickDateActionSchema: ActionSchema = {
  name: 'pick_date',
  description:
    '',
  schema: z.object({
    index: z.number().int(),
    value: z.string().min(1),
    replace_existing: z.boolean().optional(),
  }),
};

export const selectMultipleOptionsActionSchema: ActionSchema = {
  name: 'select_multiple_options',
  description:
    '',
  schema: z.object({
    index: z.number().int(),
    texts: z.array(z.string().min(1)).min(1),
    replace_existing: z.boolean().optional(),
  }),
};

export const selectCustomOptionActionSchema: ActionSchema = {
  name: 'select_custom_option',
  description:
    '',
  schema: z.object({
    index: z.number().int(),
    text: z.string().min(1),
    replace_existing: z.boolean().optional(),
  }),
};

// Tab Management Actions
export const switchTabActionSchema: ActionSchema = {
  name: 'switch_tab',
  description: '',
  schema: z.object({
    intent: z.string().default(''),
    tab_id: z.number().int(),
  }),
};

export const openTabActionSchema: ActionSchema = {
  name: 'open_tab',
  description: '',
  schema: z.object({
    intent: z.string().default(''),
    url: z.string(),
  }),
};

export const closeTabActionSchema: ActionSchema = {
  name: 'close_tab',
  description: '',
  schema: z.object({
    intent: z.string().default(''),
    tab_id: z.number().int(),
  }),
};

// Content Actions, not used currently
// export const extractContentActionSchema: ActionSchema = {
//   name: 'extract_content',
//   description:
//     'Extract page content to retrieve specific information from the page, e.g. all company names, a specific description, all information about, links with companies in structured format or simply links',
//   schema: z.object({
//     goal: z.string(),
//   }),
// };

// Cache Actions
export const cacheContentActionSchema: ActionSchema = {
  name: 'cache_content',
  description: '',
  schema: z.object({
    intent: z.string().default(''),
    content: z.string().default(''),
  }),
};

export const scrollToPercentActionSchema: ActionSchema = {
  name: 'scroll_to_percent',
  description:
    '',
  schema: z.object({
    intent: z.string().default(''),
    yPercent: z.number().int(),
    index: z.number().int().nullable().optional(),
  }),
};

export const scrollToTopActionSchema: ActionSchema = {
  name: 'scroll_to_top',
  description: '',
  schema: z.object({
    intent: z.string().default(''),
    index: z.number().int().nullable().optional(),
  }),
};

export const scrollToBottomActionSchema: ActionSchema = {
  name: 'scroll_to_bottom',
  description: '',
  schema: z.object({
    intent: z.string().default(''),
    index: z.number().int().nullable().optional(),
  }),
};

export const previousPageActionSchema: ActionSchema = {
  name: 'previous_page',
  description:
    '',
  schema: z.object({
    intent: z.string().default(''),
    index: z.number().int().nullable().optional(),
  }),
};

export const nextPageActionSchema: ActionSchema = {
  name: 'next_page',
  description:
    '',
  schema: z.object({
    intent: z.string().default(''),
    index: z.number().int().nullable().optional(),
  }),
};

export const scrollToTextActionSchema: ActionSchema = {
  name: 'scroll_to_text',
  description: '',
  schema: z.object({
    intent: z.string().default(''),
    text: z.string(),
    nth: z
      .number()
      .int()
      .min(1)
      .default(1),
  }),
};

export const sendKeysActionSchema: ActionSchema = {
  name: 'send_keys',
  description:
    '',
  schema: z.object({
    intent: z.string().default(''),
    keys: z.string(),
  }),
};

export const getDropdownOptionsActionSchema: ActionSchema = {
  name: 'get_dropdown_options',
  description: '',
  schema: z.object({
    intent: z.string().default(''),
    index: z.number().int(),
  }),
};

export const selectDropdownOptionActionSchema: ActionSchema = {
  name: 'select_dropdown_option',
  description:
    '',
  schema: z.object({
    intent: z.string().default(''),
    index: z.number().int(),
    text: z.string(),
    replace_existing: z
      .boolean()
      .optional(),
  }),
};

export const waitActionSchema: ActionSchema = {
  name: 'wait',
  description: '',
  schema: z.object({
    intent: z.string().default(''),
    seconds: z.number().int().default(3),
  }),
};
