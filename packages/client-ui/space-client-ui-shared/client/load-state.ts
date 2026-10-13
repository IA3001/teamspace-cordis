export type LoadView = 'loading' | 'error' | 'empty' | 'content'

/** Keep the empty-state message for a confirmed empty result, never as a loading placeholder. */
export function resolveLoadView(loading: boolean, failed: boolean, hasContent: boolean): LoadView {
  if (hasContent) return 'content'
  if (loading) return 'loading'
  if (failed) return 'error'
  return 'empty'
}
