/**
 * Theme access for the views (work package C02, feature F21, ADR-0002 decision 5).
 *
 * One source of truth for "which theme is on screen", and one observer for the whole bundle.
 * Before this file each view that needed the answer re-derived it from the DOM; the Join Matrix
 * attached a `MutationObserver` to every ancestor of its viewport plus a `matchMedia` listener,
 * once per mounted instance.
 *
 * `useTheme()` prefers a `ThemeProvider` above it and falls back to `useThemeDetector()`, which
 * reads `document.documentElement`'s `data-theme` (the attribute the artifact host writes,
 * `skill/assets/explorer.html:2`, `:53-56`) and, when that attribute is absent, the
 * `prefers-color-scheme` media query. The detector is a module-level store: however many views
 * subscribe, there is one `MutationObserver` on one element watching one attribute, and one
 * media-query listener, and both are torn down when the last subscriber unmounts.
 *
 * Importing this module pulls in `tokens.css`, which is how the token layer reaches the bundle:
 * esbuild collects it into `dist/extensions.css`, the artifact inlines that after the host's own
 * variable block, and a view mounted outside the artifact gets the variables from here.
 *
 * This file never writes storage. The theme choice belongs to the shell: the artifact host owns
 * `backend-buddy:<project.key>:theme` and W01 owns the SPA toggle.
 */

import React, { createContext, useContext, useSyncExternalStore } from 'react';
import { type Theme } from './palettes';
import './tokens.css';

export type { Theme } from './palettes';
export { THEMES } from './palettes';

/** Narrows an arbitrary string to a theme name. */
export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

const ThemeContext = createContext<Theme | null>(null);
const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * The theme the document is currently showing. `data-theme` wins because the shell sets it
 * deliberately; without it the system preference decides; without either, `light`, which is what
 * the bare `:root` block in `tokens.css` paints.
 */
function readTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  const attribute = document.documentElement.getAttribute('data-theme');
  if (isTheme(attribute)) return attribute;
  if (typeof matchMedia === 'function') return matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  return 'light';
}

const listeners = new Set<() => void>();
let snapshot: Theme | null = null;
let attributeObserver: MutationObserver | null = null;
let darkQuery: MediaQueryList | null = null;

/** Re-reads the theme and wakes the subscribers only when the answer actually changed. */
function refresh(): void {
  const next = readTheme();
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

function startWatching(): void {
  if (typeof document !== 'undefined' && typeof MutationObserver === 'function') {
    attributeObserver = new MutationObserver(refresh);
    attributeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  if (typeof matchMedia === 'function') {
    darkQuery = matchMedia(DARK_QUERY);
    darkQuery.addEventListener('change', refresh);
  }
}

function stopWatching(): void {
  attributeObserver?.disconnect();
  attributeObserver = null;
  darkQuery?.removeEventListener('change', refresh);
  darkQuery = null;
  snapshot = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) startWatching();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopWatching();
  };
}

function getSnapshot(): Theme {
  if (snapshot === null) snapshot = readTheme();
  return snapshot;
}

function getServerSnapshot(): Theme {
  return 'light';
}

/**
 * The theme observed from the document, through the single shared observer.
 * Views should call `useTheme()`; this is exported for the shell, which may need the observed
 * value even while it is providing one (W01's toggle starts from what the host had set).
 */
export function useThemeDetector(): Theme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * The theme for the current subtree: the nearest `ThemeProvider` if there is one, otherwise the
 * observed document theme. Both are read on every render because a hook cannot be conditional;
 * the detector costs one shared subscription, not one per caller.
 */
export function useTheme(): Theme {
  const provided = useContext(ThemeContext);
  const detected = useThemeDetector();
  return provided ?? detected;
}

export interface ThemeProviderProps {
  theme: Theme;
  children: React.ReactNode;
}

/**
 * Fixes the theme for a subtree. The provider does not touch `data-theme`, storage or the
 * media query: it states what the surrounding shell has already decided, so a test or a preview
 * can render a view in either theme without moving the whole document.
 */
export function ThemeProvider({ theme, children }: ThemeProviderProps): React.ReactElement {
  return React.createElement(ThemeContext.Provider, { value: theme }, children);
}
