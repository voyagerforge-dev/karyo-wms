/**
 * What a dashboard tile knows about its data. A tile renders each status distinctly so that
 * "still loading" and "failed to load" are never shown as an empty result: an honest absence
 * ("no open exceptions", "no storage locations yet") is only ever claimed from `ready` data.
 */
export type PanelState<T> =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: T };

/**
 * Maps a query's `data` and `isError` onto a panel state. Loaded data wins even when a later
 * refetch failed (it is still real, if stale); with no data at all the panel is `error` if the
 * query failed, else `loading`. Takes the two fields rather than the query object so callers
 * can memoize on exactly what decides the outcome.
 */
export function panelState<D, T>(data: D | undefined, isError: boolean, adapt: (data: D) => T): PanelState<T> {
  if (data !== undefined) return { status: 'ready', data: adapt(data) };
  return { status: isError ? 'error' : 'loading' };
}
