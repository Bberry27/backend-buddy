/**
 * Mount policy for the artifact's React root (work package C03, CTQ-10,
 * ADR-0002 decision 3, ADR-0004 decision 8).
 *
 * The artifact used to tear the whole React tree down on every filter keystroke: the host's
 * `render()` called `unmount()` unconditionally and `mount()` always created a new root, so the
 * City camera, the Fan-out root, the Schema Diff snapshots and the Column Table page were lost per
 * character typed. S01 fixed the host half - it now unmounts only when the view changes. This
 * module is the other half: the decision function `mount()` consults before touching the root.
 *
 * Three outcomes, and the reasons a caller cannot merge them:
 *
 *   create    there is no root yet.
 *   update    same container, same view: re-render with the new props. React reconciles, so
 *             component state and effects survive.
 *   recreate  the view changed, or the host replaced the container element. A different view is a
 *             different component tree, and a detached container cannot be re-rendered into.
 *
 * RK-05, lifecycle assumptions this changes. Reuse means a view's state now outlives a filter
 * keystroke, and two views hold state that used to be discarded by the remount:
 *
 *   - `City.tsx` clears its hover and selection whenever its `layout` memo changes (the
 *     `useEffect` on `[layout]`), which still fires when the filtered graph changes, so a filter
 *     keystroke keeps clearing the City selection. W05 narrows that to "the selected table left
 *     the graph"; until then the observable behaviour matches today's.
 *   - `SchemaDiff.tsx` holds its two loaded snapshots, its loading and error state, and its tab in
 *     component state. Those now survive a keystroke, which is the point, but it means a diff
 *     stays loaded across filter changes; W04 decides whether a snapshot change should clear it.
 *
 * Nothing here touches the DOM: the container is compared by identity only, so the function is
 * testable without a document.
 */

/** What a caller mounted last, or intends to mount. The container is compared by identity. */
export interface MountTarget {
  container: object;
  view: string;
}

export type MountDecision = 'create' | 'update' | 'recreate';

/**
 * What to do to reach `next` from `previous`. `previous` is undefined when nothing is mounted.
 * A caller that gets `update` must not unmount: that is the whole point of the policy.
 */
export function decideMount(previous: MountTarget | undefined, next: MountTarget): MountDecision {
  if (!previous) return 'create';
  if (previous.container !== next.container) return 'recreate';
  if (previous.view !== next.view) return 'recreate';
  return 'update';
}
