const GAP = 6;
const MARGIN = 8;

interface Box {
  width: number;
  height: number;
}

/**
 * Where a hover card goes for an anchor row: right-aligned under it, flipped above
 * when it would not fit below, and always clamped inside the viewport.
 */
export function placeTip(
  anchor: { top: number; bottom: number; right: number },
  card: Box,
  viewport: Box
): { top: number; left: number } {
  const clamp = (value: number, max: number) => Math.max(MARGIN, Math.min(value, max));
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - card.height;
  const fitsBelow = below + card.height <= viewport.height - MARGIN;
  const top = fitsBelow || above < MARGIN ? below : above;
  return {
    top: clamp(top, viewport.height - MARGIN - card.height),
    left: clamp(anchor.right - card.width, viewport.width - MARGIN - card.width),
  };
}
