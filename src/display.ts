// One display-name fallback for every surface. The bridge computes
// display_name (name, project folder, agent kind, pane id). Historical
// /log entries can predate that field, so the old chain remains here only
// as a compatibility fallback.
export interface DisplayNameSource {
  display_name?: string | null;
  name?: string | null;
  terminal_title_stripped?: string | null;
  pane_id: string;
}

export function resolveDisplayName(row: DisplayNameSource): string {
  return row.display_name || row.name || row.terminal_title_stripped || row.pane_id;
}
