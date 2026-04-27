const PALETTE: ReadonlyArray<{ bg: string; fg: string }> = [
  { bg: "rgba(99, 102, 241, 0.16)", fg: "rgb(165, 180, 252)" },
  { bg: "rgba(45, 212, 191, 0.16)", fg: "rgb(94, 234, 212)" },
  { bg: "rgba(244, 114, 182, 0.16)", fg: "rgb(244, 114, 182)" },
  { bg: "rgba(250, 204, 21, 0.18)", fg: "rgb(253, 224, 71)" },
  { bg: "rgba(167, 139, 250, 0.18)", fg: "rgb(196, 181, 253)" },
  { bg: "rgba(74, 222, 128, 0.16)", fg: "rgb(134, 239, 172)" },
  { bg: "rgba(248, 113, 113, 0.16)", fg: "rgb(252, 165, 165)" },
  { bg: "rgba(56, 189, 248, 0.16)", fg: "rgb(125, 211, 252)" },
];

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return h >>> 0;
}

export function colorForSource(source: string): { bg: string; fg: string } {
  return PALETTE[hash(source) % PALETTE.length];
}
