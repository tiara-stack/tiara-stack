/** Returns whether a pathname belongs to the sheet configuration editor subtree. */
export const isSheetEditorPath = (pathname: string): boolean =>
  /\/settings\/sheet(?:\/|$)/.test(pathname.replace(/\/+$/u, ""));
