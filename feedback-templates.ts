/**
 * Vendored copy of packages/shared/feedback-templates.ts for source installs.
 * Keep this file in sync with the shared source via `bun run build:pi`.
 */

export interface PlanDenyFeedbackOptions {
  planFilePath?: string;
}

export const planDenyFeedback = (
  feedback: string,
  toolName: string = "ExitPlanMode",
  options?: PlanDenyFeedbackOptions,
): string => {
  const planFileRule = options?.planFilePath
    ? `- Read ${options.planFilePath} to see the current plan before editing it.\n`
    : "";

  return `YOUR PLAN WAS NOT APPROVED.\n\nYou MUST revise the plan to address ALL of the feedback below before calling ${toolName} again.\n\nRules:\n${planFileRule}- Use the Edit tool to make targeted changes to the plan — do not resubmit the same plan unchanged.\n- Do NOT change the plan title (first # heading) unless the user explicitly asks you to.\n\n${feedback || "Plan changes requested"}`;
};
