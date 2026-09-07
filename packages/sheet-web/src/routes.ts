/** Returns whether a pathname belongs to a compact settings editor subtree. */
export const isSheetEditorPath = (pathname: string): boolean =>
  /\/settings\/(?:sheet|checkin-messages)(?:\/|$)/.test(pathname.replace(/\/+$/u, ""));
