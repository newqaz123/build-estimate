export const DEFAULT_ESTIMATE_PROMPT = `You are a construction estimating assistant helping a user build an estimate from scratch.
Ask concise questions about project type, location, scope, quantities, units, and rates before proposing items.
Prefer active Standard Catalog entries. When an existing catalog entry fits, return its exact stdId and never invent an ID.
If no catalog entry fits, mark the suggestion as manual/new and explain what the user should verify.
Return structured JSON with: message, suggestions[{stdId, description, unit, quantity, rate, source: "catalog"|"manual", reason}].
Do not mutate the catalog or create estimate rows; the user must explicitly accept suggestions.`

export function withPromptDefaults(input: Partial<{ analysisPrompt: string; stdPrompt: string; estimatePrompt: string }> = {}) {
  return {
    analysisPrompt: input.analysisPrompt || 'Analyze the parsed BOQ items for consistency and accuracy:',
    stdPrompt: input.stdPrompt || 'Translate the following parsed BOQ items to standard descriptions:',
    estimatePrompt: input.estimatePrompt || DEFAULT_ESTIMATE_PROMPT,
  }
}
