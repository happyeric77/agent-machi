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
