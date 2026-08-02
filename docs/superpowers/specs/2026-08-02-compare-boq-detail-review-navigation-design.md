# Compare BOQ Detail Review Navigation Design

## Goal

When a BOQ is uploaded or selected from `/compare` but is not yet approved, send the user to the existing BOQ details page before allowing catalog comparison. The BOQ details page remains the single source of truth for catalog preparation actions: manual **Match**, **AI**, **Dismiss**, and **Create new**.

## User flow

1. User opens `/compare` and selects a BOQ, or uploads a new BOQ for comparison.
2. If the BOQ is not approved, Compare shows the existing preparation state and a **Review, match & approve** action.
3. That action navigates to `/boqs/<id>?returnTo=<encoded compare URL>`.
4. The BOQ details page displays its normal details workspace and existing row-level catalog actions.
5. User resolves each catalog line by matching an existing catalog item, using AI, dismissing an AI suggestion, creating a new catalog entry, or excluding a one-off line with a reason.
6. After a successful approval, the details page navigates to the validated `returnTo` URL, preserving the BOQ selection.
7. Compare reloads the selected BOQ and loads the catalog comparison.

If approval fails, the user remains on BOQ details and sees the existing error handling. If no `returnTo` is supplied, approval behavior remains unchanged.

## Recommended approach

Use URL return parameters rather than session storage or a second browser tab. This is refresh-safe, shareable within the authenticated app, and keeps navigation state explicit.

### Compare page changes

- Read an optional `boq` query parameter on initial load and use it as the preferred BOQ selection.
- For uploaded BOQs, refresh the list and navigate directly to BOQ details instead of opening the legacy ReviewPanel overlay.
- For an unapproved selected BOQ, navigate the preparation CTA to the BOQ details page with a return URL such as `/compare?boq=<id>`.
- Keep approved BOQs on the existing comparison path.
- Remove Compare-only ReviewPanel state/imports if no longer used.
- Keep the existing catalog comparison Match modal for already-approved comparison rows.

### BOQ details changes

- Read an optional `returnTo` query parameter.
- After the existing successful approval mutation and toast, navigate to `returnTo` when it is a valid internal Compare URL.
- Reject external URLs and unsupported paths; when invalid or absent, keep the current details-page behavior.
- Do not duplicate or move the existing Match, AI, Dismiss, Create new, or exclusion controls.
- Preserve existing `mode=review` cleanup behavior.

## URL safety

`returnTo` must be decoded and accepted only when it is an internal path beginning with `/compare` (optionally including a query string). Absolute URLs, protocol-relative URLs, and unrelated internal paths are ignored. BOQ IDs are URL-encoded when constructing links.

## State and error handling

- Loading the BOQ list with an unknown `boq` query value falls back to the existing selection behavior.
- If comparison loading fails after returning, Compare shows its existing retry state.
- If approval is blocked by pending edits, verification issues, invalid component drafts, or catalog readiness, no redirect occurs.
- If the BOQ has no remaining catalog blockers, the existing approval success path is used.

## Testing

Add or update tests for:

- Compare query selection using `?boq=<id>`.
- Uploaded BOQs navigating to details with a return URL.
- Unapproved selected BOQs linking to details with the selected BOQ preserved.
- Details redirecting after successful approval with a valid Compare return URL.
- Details ignoring external or unrelated return URLs.
- Details retaining the existing behavior when no return URL is supplied.
- Existing details-page catalog action contracts remaining unchanged.

Manual browser QA:

1. Upload a BOQ from Compare.
2. Confirm navigation to BOQ details rather than the legacy overlay.
3. Exercise Match, AI, Dismiss, and Create new on the details page.
4. Approve the BOQ.
5. Confirm automatic return to Compare with the same BOQ selected and comparison rows loaded.
6. Confirm a failed or blocked approval stays on details.
7. Confirm the existing approved comparison layout and responsive behavior remain unchanged.
