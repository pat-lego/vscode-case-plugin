/**
 * Generates a timestamp + random suffix used in all capture filenames.
 * Format: HHhMMmSSs_XXXX  (e.g. 14h32m07s_a3f2)
 * The 4-char hex random suffix makes same-second collisions astronomically
 * unlikely (1-in-65536 per pair) even under rapid-fire captures.
 */
export function captureTimestamp(date: Date = new Date()): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hh}h${mm}m${ss}s_${rand}`;
}
