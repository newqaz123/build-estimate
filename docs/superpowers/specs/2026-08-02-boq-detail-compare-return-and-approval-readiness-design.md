# BOQ Details Compare Return and Approval Readiness

## Goal

Keep users on BOQ Details while matching multiple catalog items, while providing a reliable route back to Compare and making a disabled approval action explain the actual blocker.

## Behavior

- A successful catalog match continues to save/reload the BOQ and keeps the user on BOQ Details.
- When BOQ Details was opened from Compare, the existing validated `returnTo` URL remains the back destination.
- When BOQ Details was opened directly, the header back action links to `/compare?boq=<id>`.
- The back label is `Back to comparison` for a validated return destination and `Back to Compare` for the direct-entry fallback.
- Approval safeguards remain strict. Matching completion must not bypass pending edits, invalid component drafts, verification blockers, or unresolved priced catalog rows.
- The approval control uses one derived disabled state and exposes the first applicable blocker message near the control, so catalog readiness is not mistaken for full BOQ approval readiness.
- Successful manual matching clears its active mutation state and refreshes the canonical BOQ before recomputing readiness and approval state.

## Implementation shape

- Extend the existing route-helper usage in `src/app/(authenticated)/boqs/[id]/page.tsx` with `compareBoqHref` for the direct-entry fallback.
- Keep safe `returnTo` validation unchanged; never accept arbitrary destinations.
- Derive approval blockers from existing state (`mutationBusy`, invalid drafts, pending changes, verification, and catalog readiness) rather than duplicating validation rules.
- Render the blocker explanation adjacent to the disabled Approve BOQ action without weakening the server/client approval guards.
- Preserve the existing post-match GET/reconciliation flow and ensure its completion state is observable by the approval control.

## Testing

- Add source-contract tests for direct Details → Compare fallback and both return-label paths.
- Add source-contract tests that the approval disabled state includes all existing safeguards and exposes blocker messaging.
- Preserve tests for safe return validation, approval blockers, post-match reload, and canonical Compare navigation.
- Run `npm run check` and `graphify update .` after implementation.

## Non-goals

- No automatic redirect after matching.
- No relaxation of approval validation.
- No new session storage, external navigation, or duplicate matching UI on Compare.
