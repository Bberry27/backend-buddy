# Verification

## Source Checks

Confirm actual helper PKs and inherited columns with source/catalog evidence; test a composite key and FK rather than only single-column examples. Check the parsed totals against an independent inventory, and list remaining extraction limitations. Use synthetic fixtures to exercise empty schemas, special characters, unknown targets, multiple schemas, and identical table names across project keys.

## Browser Checks

Run the bundled checker with an available Playwright installation:

```text
node <skill>/scripts/check_explorer.cjs <absolute-output.html> <absolute-qa-directory>
```

It uses Chromium by default. Set `RELATIONAL_MAP_BROWSER_CHANNEL=msedge` or `chrome` for an installed browser. Discover bundled runtime locations through the available workspace-dependencies tool; do not bake a personal machine's paths into the skill.

Inspect generated desktop dark/light and mobile screenshots. Verify 1920x1080, 1366x768, and 390x844, plus a project-relevant narrow pane when needed. The document must not grow with the full entity list: header/toolbars stay in a bounded viewport, and graph/inspector scroll independently. Mobile tables may scroll inside their own container.

Exercise entity selection, search, domain/type filters, comparison, key-type filters, candidate rules and categories, saved review decisions, neighborhood focus, zoom/fit, CSV and SVG downloads, and theme persistence. Check empty results, long names, stale selected entities, and a graph with no links. Ensure all node labels stay inside their boxes, and all entities remain reachable at usable zoom.

The automated checker covers general rendering and common workflows. For a new adapter, add focused checks for its actual source edge cases and review SQL; passing browser checks does not prove the schema is correct. Review generated SQL without executing it unless the user authorized data validation.
