// Playwright configuration for the browser layer (work package S02, ADR-0008 decision 4).
//
// One browser only: Playwright's bundled Chromium under swiftshader. No `channel` is set
// anywhere in the tree, so `msedge` and a locally installed Chrome can never be picked up
// silently and CI, Linux, and Windows all render through the same software GL stack.
//
// Outputs go to test-results/ and playwright-report/, both git-ignored. Retries are 0: a
// flaky check must be visible and reported, not retried away (RK-07).
import { defineConfig } from '@playwright/test';

/** Software GL, so the 3D city renders identically on a CI runner without a GPU. */
export const CHROMIUM_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

export default defineConfig({
  testDir: 'tests',
  outputDir: 'test-results/artifacts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['junit', { outputFile: 'test-results/junit.xml' }]],
  use: {
    browserName: 'chromium',
    headless: true,
    launchOptions: { args: CHROMIUM_ARGS },
    acceptDownloads: true,
    viewport: { width: 1366, height: 768 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    { name: 'e2e', testDir: 'tests/e2e' },
    { name: 'security', testDir: 'tests/security' },
  ],
});
