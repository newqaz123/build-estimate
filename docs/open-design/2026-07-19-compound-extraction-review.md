# Compound extraction review — Open Design handoff

## Artifact

- Run: `5a1fa368-c515-479f-9203-3eec307dcbbb`
- Project: `b264a783-37f7-49a4-94fc-12d0a64c738e`
- Preview: <http://127.0.0.1:50049/api/projects/b264a783-37f7-49a4-94fc-12d0a64c738e/raw/index.html>
- Entry file: `boq-check-redesign.html`
- Supporting files: `boq-check-redesign.test.cjs`, `critique.json`
- Critique score: 4.4

The artifact is a design handoff only. Production reuses its decisions in the existing React workspace; generated prototype HTML is not copied into the application route.

## Component hierarchy

```text
app-shell
├── sidebar
└── product
    ├── topbar
    └── canvas
        └── review-card
            ├── boq-header
            └── review-body
                ├── pdf-panel
                ├── keyboard-resize-handle
                └── items-panel
                    ├── mode-switch
                    │   ├── boq-items-mode
                    │   └── extraction-review-mode
                    ├── BOQ items view
                    └── Extraction review view
```

The BOQ items view contains metadata and extraction warnings, search/filter controls, the parsed-items heading, section and item rows, and global/per-section “Add missing item” actions. The extraction-review view contains return-to-items and accept-all-validated actions, row filters, provider-failure feedback, proposal rows comparing original and proposed structures, evidence and reconciliation details, per-proposal actions, and a sticky review footer.

The PDF remains one mounted node while the right pane changes mode. It retains collapse, full-PDF, page, and source-focus controls, so review never opens a second legacy matching workspace.

## Canonical BOQ-row decisions

- The Open Design artifact defines six canonical editable/action columns: Description, Unit, Qty, Rate, Total, and Catalog.
- The production adaptation retains Material and Labour as two supplemental compact, read-only evidence columns because the application already preserves those source costs. They are not canonical pricing inputs and do not change the artifact's six-column editing model.
- Rate is always the editable pricing field for a priced row; Total follows `quantity × rate`.
- Remove Row details, Code, Type, Aggregate rate, and manual material/labour allocation from the UI.
- Material and labour values are compact, read-only evidence. For a separate component row, its explicit `costComponent` identity and own row rate provide the applicable evidence while the opposite column remains unprovided. For a combined row, show a component value only when it exists in source evidence; an unknown combined split remains dashes/not-provided and is never inferred.
- A shared-quantity material/labour row stays one combined priced item with separate source evidence.
- Components with different quantities, units, rates, or totals stay separate priced rows.
- Bundle children remain informational and never contribute a second total.
- Preserve matching/catalog actions and the manual add-missing-item workflow.

## Extraction-review interaction states

- The right pane uses an explicit two-button mode switch rather than navigating away.
- Proposal rows support original/proposed comparison, source evidence, reconciliation status, explanation, confidence, Accept, Reject, Recheck with AI, and Undo where applicable.
- “Accept all” applies only validated high-confidence proposals.
- Provider failure, loading, empty, filtered-empty, invalid proposal, accepted, rejected, and focus states remain visible and recoverable.
- Motion is restrained and task-led; reduced-motion behavior must be preserved.

## Responsive behavior

- At `≤1100px`, the split becomes 42% PDF / 58% right pane and the description column is 25%.
- At `≤920px`, the app becomes single-column with a sticky 56px bottom navigation; the PDF stacks above the right pane at 36vh; the resizer is hidden; item tables become two-column labelled cards; original/proposed structures stack; sticky actions sit above the bottom navigation.
- At `≤520px`, item cards become one column, filters scroll horizontally, the secondary header action hides, and the PDF keeps a 280px minimum width.

## Existing tokens to reuse

- Accent and focus: `--accent`, `--ring` (`#1b61c9`)
- Deep navy / foreground: `--foreground`, `--primary`, `--color-navy` (`#181d26`)
- Borders and muted surfaces: `--border` (`#e0e2e6`), `--muted`, `--border-soft`
- Typography: `--font-display`, `--font-body`, and `--font-mono` for numeric evidence
- Spacing: `--space-1` through `--space-12`
- Radii: `--radius-brand-sm` (12px), `--radius-brand-md` (16px), `--radius-brand-lg` (24px), and `--radius-pill`
- Elevation and interaction: `--elev-raised`, `--motion-fast`, `--motion-base`, `--ease-standard`, and `--focus-ring`

The critique favored explicit modes, a dominant PDF/canonical-table hierarchy, restrained motion, and a single-accent Airtable-like visual language with the existing blue-tinted raised shadow.
