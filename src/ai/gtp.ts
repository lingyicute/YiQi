const GTP_COORD = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'] as const;

/** The GTP name for an intersection: column letter, then row counted from the bottom. A pass is 'pass'. */
export function formatGtpMove(x: number, y: number, boardSize = 19): string {
  if (x < 0 || y < 0) return 'pass';
  const column = GTP_COORD[x];
  if (column === undefined) throw new Error(`GTP column out of range: ${x}`);
  return `${column}${boardSize - y}`;
}
