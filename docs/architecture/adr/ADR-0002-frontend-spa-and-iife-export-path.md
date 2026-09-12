Status: draft | Owner: Frontend lead | Last verified against code: pre-repo (2026-09-07)

# ADR-0002: Frontend stack (Vite + React 19 + React Router 7) with the esbuild IIFE kept as the artifact export path

- **ADR status**: proposed
- **Date**: 2026-09-07
- **Deciders**: Product owner, Frontend lead, Platform lead
- **Work packages**: C02, C03, W01, W02, W03, W05
- **Related**: ADR-0001, ADR-0004 (selection/routing), ADR-0006 (artifact CSP), F14, F21, F22

## Context

Today there is no application shell in React. `skill/assets/explorer.html` owns theme, tablist, filters, inspector, and four views in vanilla JS (`:21-25`, `:60-69`, `:73-80`); the nine React views are compiled by one esbuild call into an IIFE with `globalName: 'BackendBuddyViews'` (`packages/explorer/build.mjs:2`) and mounted through `mount(container, view, props)` / `unmount()` (`packages/explorer/src/index.tsx:21-22`). There is no router, store, context, dev server, or entry HTML; `tsconfig.json` is typecheck-only.

Forces:

- The host tears the React tree down on every filter keystroke: `render()` at `explorer.html:178` starts with `window.BackendBuddyViews?.unmount()`, the filter inputs at `:68` call `render()` on `input`, and `mount()` at `index.tsx:22` always calls `unmount()` then `createRoot()`. City camera, Fan-out root, Schema Diff loaded snapshots, and Column Table paging are lost per keystroke (CTQ-10 requires 0 remounts across 20 keystrokes).
- The offline artifact must keep working from `file://` under the byte-identical CSP (`explorer.html:6`, D9, CTQ-05). Code splitting is blocked there: the artifact allows only inline scripts and no network, so the single IIFE remains the right shape for the artifact even though the SPA wants lazy chunks.
- The bundle is one 1.5 MB IIFE with no sourcemap or metafile (`build.mjs:2` sets neither); three.js is used only by City; `d3-array` and `d3-selection` are unused (plan). CTQ-09 sets budgets: shell <= 350 KB gzipped, City chunk <= 700 KB, Living ERD chunk <= 250 KB.
- Theming lives in 16 CSS variables at `explorer.html:9-10`; components re-derive theme from the DOM, for example `JoinMatrix.tsx:103-111` attaches a `MutationObserver` to every ancestor. The SPA needs one theme source that also serves the artifact.
- The skill byte-copies `packages/explorer/src` (`scripts/project.mjs:52-60`) and must build without the SPA, the router, or a test runner other than `node:test` (`packages/explorer/package.json` test script `tsx --test src/*.test.ts`).
- Quoted from `docs/reference/caveats.md` (C16): "The flat, accessible rendering (flat SVG City, keyboard-reachable tables, text alternatives for canvas and WebGL surfaces) remains available in every release. It uses the same layout data as the 3D scene, can be chosen at any time, and is entered automatically when WebGL is unavailable or lost."

## Decision

1. Build the application shell as a Vite + React 19 + TypeScript SPA in `packages/web`, using React Router 7 in library mode for `/login`, `/w/:ws`, project pages, and `/w/:ws/p/:project/s/:snapshot/:view`; Zustand for shell state; Vitest + Testing Library + jsdom for tests; lazy chunks for City and Living ERD; `scripts/size-budget.mjs` enforcing CTQ-09.
2. Keep every shell-neutral module in `packages/explorer`: design tokens and theme (`tokens.css`, `palettes.ts`, `color-math.ts`, `theme.tsx`), `route-state.ts`, `selection.ts`, `navigation.ts`, `view-state.ts`, `mount-policy.ts`, `caveat-strings.ts`, the Inspector, the four ported host views, and the pure logic modules. ESLint `no-restricted-imports` forbids router, `fetch`, and Vitest inside `packages/explorer` so the skill copy keeps building with `node:test` only.
3. `ViewHost` in the SPA mounts exactly one view and updates props on filter change; no unmount. In the artifact, `index.tsx` reuses its root (`mount-policy.ts`, C03): `mount()` re-renders with new props when the view id is unchanged and unmounts only on view change; `explorer.html` `render()` is changed accordingly (S01).
4. The esbuild IIFE build (`packages/explorer/build.mjs`) is retained solely as the export path for the offline artifact and the skill; it gains `metafile` and `sourcemap` outputs for size analysis but no splitting. The SPA never loads the IIFE.
5. Theme is delivered through `html[data-theme]` plus `tokens.css` (values byte-identical to `explorer.html:9-10`) and a `theme` prop on `ViewProps`; the artifact uses a single `useThemeDetector` observer, replacing the per-view observers.
6. Host behaviour is re-expressed, not re-invented: tablist keyboard model (`ArrowLeft/Right/Home/End`, `explorer.html:67`), `scoped()` filter semantics (`:60`), breakpoints `1800/1050/700` (`:12-14`), `role=status` regions (`:25-26`), and the flat City fallback (C16) are carried over with tests.

## Consequences

- Positive: routing, deep links, back/forward, HMR, lazy chunks, component tests; nine views compile untouched (additive `ViewProps`, ADR-0004); the skill keeps its single-file artifact.
- Negative: two build systems (Vite for the SPA, esbuild for the artifact) and two test runners (Vitest in `packages/web`, `node:test` in `packages/explorer`); mitigated by keeping the boundary a package boundary with lint enforcement. Root reuse changes lifecycle assumptions (City clears selection on layout change at `City.tsx:309`; Schema Diff loaded snapshots); mitigated by per-view prop-change component tests before enabling reuse in the artifact (plan risk "Remount fix").
- Neutral: the artifact remains one IIFE and one large file; its size budget is "to be decided" (`docs/reference/limits-and-caps.md` B).

## Alternatives considered

- Next.js or another server-rendered framework: rejected; the API is Python, the product is a self-hosted SPA behind one origin, and SSR adds a Node runtime to the image.
- esbuild-only SPA with a hand-rolled router: rejected; no HMR, no ecosystem for lazy routes, and the router would be a second routing contract to maintain.
- Extend the vanilla-JS host into the application: rejected; the inspector, four views, and filters would remain string-built `innerHTML` (12 sinks, one confirmed XSS at `explorer.html:77`) and the host cannot host a persistent React tree.
- Drop the IIFE and render the artifact from the Vite build: rejected; Vite emits module scripts and hashed assets that violate the byte-identical offline CSP (`connect-src 'none'`, inline-only scripts).
- Do nothing: rejected; CTQ-10 (no remounts, deep links) and the MVP definition are unreachable.

## CTQs affected

- CTQ-10 drill-through completeness: routing and no-remount `ViewHost` are the mechanism.
- CTQ-09 performance: lazy chunks and size budgets; TTI per view measured in Q01.
- CTQ-02, CTQ-11: shell breakpoints, tablist, live regions, reduced motion, and axe runs across routes.
- CTQ-05: the artifact export path is unchanged and byte-identical CSP is preserved.
- CTQ-12: Vitest coverage for `packages/web`, `node:test` coverage for `packages/explorer`.

## Verification

- W01: `window.__backend-buddyMounts` constant across 20 filter keystrokes (e2e); `scripts/size-budget.mjs` green; Vitest suite for `ViewHost`, tablist, filters.
- C03: `mount-policy.test.ts` (root reuse), `index.tsx` re-render without remount in the artifact (`verify_host` remount counter, S02).
- S02: ESLint `no-restricted-imports` fails on any router/fetch/Vitest import under `packages/explorer`.
- C02: `tokens.test.ts` asserts the 16 variable values equal `explorer.html:9-10`; `scripts/check-hardcoded-colors.mjs` zero hex outside tokens/palettes.
- Gate G1 for C03 and S02 items; Gate G2 for W01.

## Change log

| Date | Change | By (role) |
|---|---|---|
| 2026-09-07 | Created (proposed) | Frontend lead |
| 2026-09-07 | Review fix: `detail()` citation corrected to `explorer.html:73-80` | Frontend lead |
