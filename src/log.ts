const lines: string[] = [];

export function logLine(message: string): void {
  const entry = `${new Date().toISOString()} ${message}`;
  lines.push(entry);
  console.log(`[machi] ${entry}`);
}

export function getLog(): readonly string[] {
  return lines.slice();
}
