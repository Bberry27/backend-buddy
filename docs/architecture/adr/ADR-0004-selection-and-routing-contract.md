Status: draft | Owner: Frontend lead | Last verified against code: pre-repo (2026-09-07)

# ADR-0004: Selection and routing contract for drill-through

- **ADR status**: proposed
- **Date**: 2026-09-07
- **Deciders**: Product owner, Frontend lead, Design and accessibility lead
- **Work packages**: C03, W02, W04, W05
- **Related**: ADR-0002, `docs/architecture/drill-through-contract.md`, `docs/architecture/schema-graph-contract.md` (B3 id forms), F14, F15, F08

## Context

Drill-through today is one-directional and lossy. `ViewProps` offers only `onSelectTable(id)` and optional `onSelectTables(ids)` (`packages/explorer/src/types.ts:10`); no view receives a selection, so each keeps a private one (`City.tsx:273`) that can diverge from the host inspector. There is no `onSelectColumn`, `onSelectRelationship`, or `onNavigate`; the only view-to-view jumps are the inspector buttons `#focusEntity` and `#entityKeys` (`skill/assets/explorer.html:78`). Nothing touches the URL: `state` is a plain object (`explorer.html:37`), so there are no deep links and no history. Every filter keystroke remounts the React tree (`explorer.html:178`, `:68`; `index.tsx:22`).

Forces:

- Nine views must compile untouched until W04 wires them, so new fields must be optional and `onSelectTable` unchanged.
- The artifact has no router; whatever grammar the SPA uses must also be parseable from `location.hash` by a pure module in `packages/explorer`.
- Per-view state has two kinds: shareable (root table, mode, filters) and volatile (camera pose, pan offsets, loaded diff snapshots). Living ERD already persists positions under a fingerprinted key `backend-buddy-erd:v1:<project.key>:<fingerprint>` computed by `snapshotKey()` (`living-logic.ts:68-73`), which must keep working.
- Deep links are untrusted input: ids, filter strings, and view-local values arrive from URLs (CTQ-07 deep-link fuzz).
- Live actions must never fire from navigation: `live.subtree` runs only from Fan-out's Run (`Fanout.tsx:94`), `live.profile` only from buttons (`ColumnTable.tsx:149`, `NormalizationLens.tsx:110-121`, `:127`).
- Quoted from `docs/reference/caveats.md` (C13): "Browser storage holds convenience state only: theme, layouts, camera, and local decisions. It is not a team review database. Every stored key is scoped by the project's stable key (and, where the data depends on the schema, by the snapshot fingerprint) so that different projects and environments never read or overwrite each other's state."
- Quoted from `docs/reference/caveats.md` (C14): "The product never discovers or connects to a database implicitly, and never to production to make a view look populated. Live access uses only a connection the user explicitly selected, opened read-only with bounded queries, and a metadata request never authorizes scanning customer rows."

## Decision

1. **Selection model** (`selection.ts`): `Selection { tableId?, tableIds?, columnId?, relationshipRef?, findingId?, origin? }` with id forms `table.id`, `table.id#column`, and relationship ref = `constraintId` else `source.column>target.targetColumn`; `NavigationTarget { view, selection?, viewState?, reason? }`.
2. **Additive `ViewProps`**: `selected?`, `onSelectColumn?`, `onSelectRelationship?`, `onNavigate?`, `viewState?`, `onViewStateChange?`, `fullGraph?`, `theme?`; `onSelectTable` unchanged.
3. **Route grammar**: `/w/:ws/p/:project/s/:snapshot/:view` with query keys `t c r ts f q d k` and `v.*` (per-view allowlist, values capped at 200 characters), parsed and serialized canonically by `route-state.ts`; the artifact shares the grammar through `location.hash`. Unknown ids and undeclared `v.*` keys are dropped with a warning.
4. **View state**: `view-state.ts` extracts the fingerprint from `snapshotKey()` with unchanged output and stores volatile per-view state under `backend-buddy:view-state:v1:<project.key>:<fingerprint>:<view>`; Living ERD positions also go to `erd_layouts` server-side.
5. **Registry**: `navigation.ts` holds entries P1-P10 with `targetsFor` and `resolve`; the inspector menu, context menus, and the generated e2e matrix are produced from it.
6. **Highlight rules**: inbound `data-selected="true"` + `is-selected`; dim non-related only when `origin` differs; scroll/pan/fly once per selection change; selection survives filter changes; reduced motion honoured.
7. **Prefill, never execute**: a drill-through may prefill a live query (`v.pk`, `v.root`) but the user must click Run; the e2e matrix asserts no `/api/subtree` or `/api/profile` request before a click.
8. **No remount**: `mount-policy.ts` and `ViewHost` update props in place; `window.__backend-buddyMounts` (non-production) is constant across 20 filter keystrokes.

Full detail: `docs/architecture/drill-through-contract.md`.

## Consequences

- Positive: bidirectional, deep-linkable navigation across 13 views plus Insights with one grammar for SPA and artifact; testable by generation from the registry; existing views unaffected until wired.
- Negative: every view is touched once in W04 (and must not be touched earlier, plan risk "Contract churn"; C03 is a hard prerequisite of W01); `v.*` allowlists must be maintained per view; canonical serialization needs care for stable history entries.
- Neutral: the artifact only reads `location.hash` at MVP; writing it and in-artifact "Open in" are L-05.

## Alternatives considered

- A global event bus or store shared by views: rejected; views would import shell code, breaking the skill copy and the lint boundary.
- Selection as part of `graph` (mutating table objects): rejected; graphs are immutable snapshots and are shared across views.
- Free-form query parameters per view: rejected; not fuzz-safe and not testable by generation.
- Hash routing in the SPA to match the artifact: rejected; React Router query strings give history and server-side redirects, and the parser is shared anyway.
- Do nothing: rejected; CTQ-10 and the MVP definition require inbound and outbound drill-through in every view.

## CTQs affected

- CTQ-10: 13 views inbound and outbound; 0 remounts over 20 keystrokes.
- CTQ-03: pan/click separation preserved while adding selection (map, City, Living ERD).
- CTQ-07: deep-link fuzz, storage isolation by `project.key`.
- CTQ-11: keyboard-only drill-through journeys; context menu via Shift+F10.
- CTQ-06: prefill never executes.

## Verification

- C03: `route-state.test.ts`, `selection.test.ts`, `navigation.test.ts`, `view-state.test.ts` (fingerprint parity with `snapshotKey()`), `mount-policy.test.ts` (Gate G1).
- W04: `tests/e2e/drill-through.spec.ts` generated from the registry; asserts markers, URL round trip via reload, no live request before Run; `__backend-buddyMounts` constant (Gate G2).
- W02: inspector "Open in" menu lists exactly `targetsFor(selection, view)`; breadcrumb of 6 entries and history back/forward.
- Q02: deep-link fuzz over `t c r ts f q d k v.*`.

## Change log

| Date | Change | By (role) |
|---|---|---|
| 2026-09-07 | Created (proposed). Note: the approved plan's prose refers to this decision as "ADR-0005"; the enumerated ADR list places selection/routing at 0004. This file follows the enumerated list. | Frontend lead |
