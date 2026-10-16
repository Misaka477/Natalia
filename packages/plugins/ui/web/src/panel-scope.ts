/**
 * The re-mount key for the shell's OWN right-side panels (review, plan,
 * governance, Nia, collab).
 *
 * Those five hold session-scoped cursors, previews and editors, so a change of
 * SESSION or WORKSPACE must rebuild them — that part is design, not defect.
 * What was a defect is that the key was not a function of its inputs alone: it
 * mixed two different sources (a workspace id looked up in the debounced
 * session list, falling back to the projection's active workspace) and read
 * them out of a projection snapshot that the shell replaces on nearly every
 * event. Two consequences, both reported from the field:
 *
 *   * the key could alternate between two strings while nothing real changed
 *     (the session list is refreshed after events, so it is briefly empty, and
 *     the fallback then disagrees with what the lookup would have returned);
 *   * a keyed `<Show>` destroys and rebuilds its subtree on ANY change, so
 *     every message — or a permission switch, which emits a system message —
 *     re-mounted the panel: xterm instances, sockets, scrollback, an open
 *     diff, an editor's unsaved buffer, all gone.
 *
 * One source, one value: equal inputs produce an equal key, so a re-mount can
 * only happen when the workspace or the session really changed.
 */
export function panelScopeKey(input: {
  workspaceID?: string | undefined;
  sessionID?: string | undefined;
}): string {
  // A NUL can never appear in an id, so "no session attached" cannot collide
  // with a session that happens to be called `none`.
  const session = input.sessionID?.trim() ? input.sessionID : "\u0000";
  return `${input.workspaceID ?? ""}\u0000${session}`;
}
