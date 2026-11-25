declare module 'decision-validators' {
  type Validator = (value: unknown) => boolean;
  export const navigator_output: Validator;
  export const planner_output: Validator;
  export const application_structure: Validator;
  export const application_values: Validator;
  export const application_repair: Validator;
  export const application_option_choice: Validator;
  export const application_form_audit: Validator;
  export const application_control_targets: Validator;
  export const application_control_step: Validator;
  export const application_value_equivalence: Validator;
}
