Status: draft | Owner: Design and accessibility lead | Last verified against code: pre-repo (2026-09-07)

# WP-Q04 UX protocol and round 1

| Field | Value |
|---|---|
| Work package | Q04 (track Q, phase 2) |
| Features | F14 (drill-through journeys), F08 (City tasks), F15, F18, F04 (task set spans them) |
| CTQs | CTQ-10, CTQ-11 (journeys observed); UX round targets are G2 criteria in `roadmap.md` |
| Caveats | none authored (the protocol checks that participants read C01, C05, C08 wording as intended) |
| Depends on | W04, W05, W06 |
| Blocks | none (G2 exit) |
| Branch | `q04/ux-protocol` |
| Gate | G2 |

### 1. Goal

Write `docs/qa/ux-testing-protocol.md` (5 participants across personas P1-P6, 8 tasks each with an optimal path through the navigation registry, success rate >= 80 % unassisted, path efficiency <= 1.5, SUS >= 72), add opt-in local navigation telemetry that records `entryId` only, write `docs/qa/release-checklist.md`, then execute round 1 at G2 on synthetic fixtures and triage the issues into the owning work packages. A verifier can check the protocol's tasks map to registry entries, the telemetry stores nothing but `entryId` and a timestamp locally, and the round-1 report exists with the three metrics.

### 2. Reading list (ordered)

1. `docs/business/business-case.md` personas P1-P6 (`### P1` to `### P6` around lines 82-119) and the jobs-to-be-done table: participants are recruited to match; tasks are their jobs.
2. `docs/features/F14-drill-through-navigation.md`, `F08-schema-city.md`, `F15-inspector.md`, `F18-insights-and-recommendations.md`, `F04-schema-review.md` sections 1-2 and 4: the tasks must exercise MVP behaviours, not later items.
3. `docs/architecture/drill-through-contract.md` 6 (P1-P10): each task's optimal path is a sequence of registry entries; path efficiency = observed steps / optimal steps.
4. `docs/product-management/roadmap.md` G2 "UX round 1" line and `ctq.md` CTQ-11 open question 3 (the two keyboard-only journeys: inspector -> City fly-to, review finding -> Column Table; round 1 observes both with one participant using keyboard only).
5. `docs/reference/caveats.md` C01, C05, C08: a comprehension probe per caveat is part of the protocol (do participants read "unknown" as unknown, "sample" as not proof, "candidate" as not a verdict).
6. `docs/engineering/accessibility-standards.md` (D03): session accommodations, reduced-motion participant.
7. `docs/architecture/security-architecture.md` 9 and ADR-0007: sessions use synthetic fixtures only; recordings contain no customer schema.
8. C03 `navigation.ts` (`entries` ids are the telemetry vocabulary) and W01's store (where the opt-in hook lives).
9. `docs/qa/release-security-checklist.md` (Q02) to merge or cross-reference into `release-checklist.md`.

### 3. In scope

- `docs/qa/ux-testing-protocol.md`: recruitment matrix (5 participants; at least one each of P1, P2, P3; the remaining two from P4-P6; one keyboard-only session; one reduced-motion session), consent text (synthetic data, no recording of anything but the product), 8 tasks with: goal, starting route, optimal registry path (entry ids), success definition, assist definition, time cap; scoring: unassisted success rate (target >= 80 %), path efficiency (observed/optimal, target <= 1.5), SUS questionnaire (target >= 72); the three caveat comprehension probes; issue severity scale; triage rule (each issue gets an owning WP id or L-item and a CTQ where relevant).
- Opt-in local navigation telemetry: a setting in the SPA (default off, per user preference) that appends `{entryId, viewFrom, viewTo, ts}` to `localStorage` under `backend-buddy:telemetry:v1:<project.key>` (C13 scoped), exportable as JSON by the participant, never sent anywhere (`connect-src 'self'` unchanged; no API endpoint); the facilitator uses the export to compute path efficiency. Implemented as a small hook in `packages/web` reading `navigation.entries`; component test proves only the four fields are stored; the hostile fixture produces no other content in the record.
- `docs/qa/release-checklist.md`: the G2/REL checklist: every CTQ row with its command and result column, UX round metrics, security checklist link (Q02), docs lint (Q05), rollback rehearsal (O02), and the MVP definition sentence checked item by item.
- Round 1 execution at G2 (after W04, W05, W06 merge): facilitator notes template, per-participant sheet, `docs/qa/ux-round-1.md` report (dates, participant codes only, metrics, issues table with owning WP, decisions), issues filed as "Out of scope, found" entries in the report and, if the owner agrees, as roadmap change requests.
- F14, F08, F15, F18, F04 section 14 rows ("UX round 1 findings"); CHANGELOG line.

### 4. Out of scope

- Fixing UX issues (owning WPs or L-items); redesigns.
- Any telemetry that leaves the browser, any server-side analytics, any third-party script (CSP and privacy policy).
- Marketing research, pricing interviews (business case, "to be validated" items are the owner's).
- Round 2 or later rounds.
- Changing the targets (>= 80 %, <= 1.5, >= 72) without a roadmap change.

### 5. May modify

```
docs/qa/ux-testing-protocol.md
docs/qa/release-checklist.md
docs/qa/ux-round-1.md
docs/qa/templates/**                          (facilitator notes, participant sheet, SUS form)
packages/web/src/telemetry/**                 (opt-in local telemetry hook, setting, export)
packages/web/src/**                           (only the settings entry and the hook call site; coordinate with W01 owner)
tests/e2e/telemetry.spec.ts
docs/features/F04-schema-review.md, F08-schema-city.md, F14-drill-through-navigation.md, F15-inspector.md, F18-insights-and-recommendations.md   (section 14 only)
CHANGELOG.md                                  ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror
fixtures/**                             generated
THIRD_PARTY_NOTICES.md                  generated
package.json, package-lock.json         no dependency change
packages/explorer/src/**                W and C tracks (telemetry lives in packages/web, reads navigation.ts read-only)
services/**, deploy/**                  no server-side telemetry
docs/business/**                        D01; persona corrections are proposed in the report
docs/reference/caveats.md               frozen at G0
docs/product-management/roadmap.md      targets change only by change control
.github/workflows/**                    O02, Q05
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Telemetry records `entryId`, `viewFrom`, `viewTo`, `ts` only; local; opt-in; scoped by `project.key` | plan (Q04 "entryId only"); C13 | `tests/e2e/telemetry.spec.ts`; component test |
| No new network destination; SPA CSP `connect-src 'self'` unchanged; no new endpoint | `security-architecture.md` 6.2 | `CTQ-07 csp violations = 0` (Q02) |
| Task optimal paths are sequences of registry entries P1-P10 | `drill-through-contract.md` 6 | protocol review against `navigation.ts` |
| Targets: unassisted success >= 80 %, path efficiency <= 1.5, SUS >= 72 | `roadmap.md` G2 | `ux-round-1.md` |
| Synthetic fixtures only in sessions and recordings | ADR-0007 | guard; protocol consent text |
| Caveat comprehension probes quote `caveats.md` verbatim | C01, C05, C08 | docs lint DL-05 |
| Storage key family `backend-buddy:telemetry:v1:<project.key>` | C13 | `storage-isolation.spec.ts` (Q02) extended by one key |

### 8. Deliverables checklist (definition of done)

- [ ] Protocol, checklist, telemetry hook and tests green with the acceptance commands
- [ ] Feature document section 14 rows added after round 1 (F04, F08, F14, F15, F18)
- [ ] Migration: none, because telemetry is local only
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist completed (no network, no PII, opt-in default off, export is user-initiated)
- [ ] Accessibility result recorded (axe 0 serious/critical on the settings entry; the keyboard-only and reduced-motion sessions' observations)
- [ ] Performance measurement: not applicable (telemetry writes are per navigation; record that TTI numbers from Q01 are unchanged)
- [ ] Caveat text only from `caveat-strings.ts` in the UI; verbatim `caveats.md` quotes in the protocol
- [ ] `npm run guard` green; no screenshots or recordings of anything but synthetic fixtures committed
- [ ] `npm run build`: not applicable unless `packages/explorer` changed (it must not)
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: `ux-round-1.md` reports the three metrics and an issues table where every row has an owning WP or L-item

### 9. Acceptance commands

```sh
npm run restore
npm run guard
npm --prefix packages/web test -- --coverage
npx playwright test tests/e2e/telemetry.spec.ts            # opt-in off by default; record shape; export content
npx playwright test tests/security/storage-isolation.spec.ts tests/e2e/csp.spec.ts
node scripts/docs_lint.mjs                                  # after Q05; until then the DL-01/DL-05 checks by hand
grep -c -E 'P([1-9]|10)' docs/qa/ux-testing-protocol.md     # >= 8 (each task cites registry entries)
```

Package-specific assertions: the telemetry export JSON has keys exactly `entryId`, `viewFrom`, `viewTo`, `ts` on every record; with the setting off, `localStorage` has no `backend-buddy:telemetry:` key after 10 navigations; `ux-round-1.md` states the metrics against the targets.

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10 (files changed; acceptance commands run; definition of done; frozen contracts; measurements; out of scope, found; open questions; deviations). Measurements are the three UX metrics; "Out of scope, found" is the triaged issue list.

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-03 docs-first | Round 1 runs only on merged W04/W05/W06; the protocol is written earlier so it does not delay G2. |
| RK-10 scope creep | Issues are triaged to owners; no fixes here. |
| RK-01 private data | Sessions use fixtures; recordings, if any, are not committed. |
| RK-19 storage origin split | Telemetry is convenience data; loss is acceptable and stated in the setting's description. |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |
