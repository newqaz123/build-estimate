# Catalog Historical Pricing Design

## Goal

Give every catalog item a transparent historical unit-price summary and ensure Compare always uses the same approved matched pricing records.

## Pricing policy

- Include only positive unit rates from approved BOQs whose item is explicitly matched to the catalog entry.
- Exclude unmatched, pending, excluded, rejected, draft, parsed, active, and review records.
- Normalize compatible units through the workspace unit map.
- Catalog includes every qualifying record in its average.
- Compare excludes the currently selected BOQ from the same record set to prevent self-biased results.

## Data model and API

- Add a shared historical-pricing calculator that returns count, minimum, average, maximum, and source records.
- Each source record identifies the BOQ, project, vendor, date, item, unit, and unit rate so the calculation is auditable.
- Enrich the authenticated Standards API response with computed historical pricing. The pricing is derived from approved BOQs on read, so edits, matches, deletions, and approvals cannot leave stale stored aggregates.
- Make BOQ comparison consume the same calculator and filter out the selected BOQ before deriving its benchmark.

## Catalog UX

- Add an “Average approved unit price” column to the Standard Catalog.
- Show the average, source count, and range when history exists.
- Make the price summary clickable. Open a detail dialog listing every included BOQ rate and the arithmetic calculation.
- Show “No approved matched history” when no qualifying records exist.

## Material and labour units

- Material and labour are independent catalog items, not rate components that must share one unit.
- Each item keeps its own description, quantity, unit, and historical pricing; for example, pipe uses `pcs` while welding uses `DB`.
- Never add or average rates with different units. Estimate totals are calculated per line and then summed.
- Do not create assemblies, child rows, conversion coefficients, or automatic quantity linkage. Changing pipe quantity must not change welding quantity.

## Estimator UX

- Adding a catalog item creates one independent estimate line.
- Seed its editable rate from that catalog item’s approved historical average for the exact compatible unit.
- Material, labour, and combined-work items all use the same rule: their own catalog history seeds their own line.
- Show the pricing source and source count in the catalog picker. If no history exists, seed zero and clearly request a manual rate.
- Save the selected rate in the estimate snapshot so later catalog-history changes do not rewrite existing estimates.
- Provide the same historical default rate to catalog-backed AI estimator suggestions.

## Compare UX

- Show the approved historical average and plain-language variance for every matched row with prior history.
- Show “No prior approved history” and “Not enough history to compare” rather than dashes when the selected BOQ is the only source or no prior sources qualify.
- Preserve the existing min–max range and sample count.

## Verification

- Unit-test approved/matched filtering, compatible units, provenance, self-exclusion, and arithmetic results.
- Test that Standards API enrichment and Compare return consistent aggregates.
- Test Catalog and Compare UI contracts, then run TypeScript, lint, build, browser QA, and graph update.
