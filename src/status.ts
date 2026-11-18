// One colour source for the roster dots, Log labels and the in-town home signs.
export const STATUS_COLORS = {
  idle: "#7ea8c4",
  working: "#f2b705",
  blocked: "#e2604a",
  done: "#6ec08a",
  unknown: "#8d9891",
} as const;

export type StatusName = keyof typeof STATUS_COLORS;

export function statusColor(status: string): string {
  return STATUS_COLORS[status as StatusName] ?? STATUS_COLORS.unknown;
}

// Sole status → badge map. Sign and head sprites only draw what this returns.
export type StatusBadgeGlyph = "check" | "!";

export interface StatusBadge {
  glyph: StatusBadgeGlyph;
  fill: string;
  stroke: string;
  ink: string;
}

const STATUS_BADGES: Partial<Record<StatusName, StatusBadge>> = {
  done: { glyph: "check", fill: STATUS_COLORS.done, stroke: "#1c4630", ink: "#ffffff" },
  blocked: { glyph: "!", fill: "#f2b705", stroke: "#5e4a12", ink: "#2b2410" },
};

export function statusBadge(status: string): StatusBadge | null {
  return STATUS_BADGES[status as StatusName] ?? null;
}
