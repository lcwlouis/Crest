// The column arithmetic of a split, as the Mac's BrowserSplitColumnLayout
// does it: fractions in, widths out. Widths are never negative and add up to
// the row less its gaps whenever the row can seat every card at its minimum;
// when it cannot, every card is the minimum and the row clips. Layout never
// dissolves a split to make it fit.

/** BrowserSplitLayoutMetrics: the gap between two cards and the narrowest a card becomes. */
export const splitGap = 8;
export const minimumCardWidth = 240;
/** The divider's pointer target: the gap and 4 points past it on each side. */
export const resizeHandleWidth = splitGap + 4 * 2;

export function equalFractions(count: number): number[] {
    return count > 0 ? Array.from({ length: count }, () => 1 / count) : [];
}

/** The caller's fractions as shares adding up to one, or equal ones for a list that holds a non-share. */
export function normalizedFractions(fractions: readonly number[]): number[] {
    if (fractions.length === 0) return [];
    if (!fractions.every((share) => Number.isFinite(share) && share > 0)) return equalFractions(fractions.length);
    const total = fractions.reduce((sum, share) => sum + share, 0);
    if (!Number.isFinite(total) || total <= 0) return equalFractions(fractions.length);
    return fractions.map((share) => share / total);
}

/** The fractions a split starts with: the stored ones while they still fit its members, else equal columns. */
export function seedFractions(persisted: readonly number[] | undefined, memberCount: number): number[] {
    if (memberCount <= 0) return [];
    if (!persisted || persisted.length !== memberCount) return equalFractions(memberCount);
    return normalizedFractions(persisted);
}

function availableWidth(containerWidth: number, columnCount: number, gap: number): number {
    return columnCount > 1 ? containerWidth - Math.max(0, gap) * (columnCount - 1) : containerWidth;
}

/** The width of each card in a row `containerWidth` wide. */
export function columnWidths(containerWidth: number, fractions: readonly number[], gap = splitGap, minimum = minimumCardWidth): number[] {
    if (fractions.length === 0) return [];
    const floor = Math.max(0, minimum);
    const available = availableWidth(containerWidth, fractions.length, gap);
    if (available <= floor * fractions.length) return fractions.map(() => floor);
    const shares = normalizedFractions(fractions);
    const widths = shares.map(() => 0);
    let flexible = shares.map((_, index) => index);
    let remaining = available;
    // Each pass leaves at least one card above the floor, so the loop ends.
    while (flexible.length > 0) {
        const shareTotal = flexible.reduce((sum, index) => sum + shares[index]!, 0);
        if (shareTotal <= 0) {
            for (const index of flexible) widths[index] = remaining / flexible.length;
            break;
        }
        for (const index of flexible) widths[index] = (remaining * shares[index]!) / shareTotal;
        const flooring = flexible.filter((index) => widths[index]! < floor);
        if (flooring.length === 0) break;
        for (const index of flooring) {
            widths[index] = floor;
            remaining -= floor;
        }
        flexible = flexible.filter((index) => !flooring.includes(index));
    }
    // Division noise goes to the widest card, so the widths add up exactly.
    const residual = available - widths.reduce((sum, width) => sum + width, 0);
    if (residual !== 0) {
        let widest = 0;
        widths.forEach((width, index) => {
            if (width > widths[widest]!) widest = index;
        });
        widths[widest]! += residual;
    }
    return widths;
}

/**
 * The fractions a divider drag lands on: only the pair around the divider
 * after card `dividerIndex` moves, by `delta` from where the drag began, and
 * it stops as either side reaches the minimum.
 */
export function fractionsAfterResize(
    fractions: readonly number[],
    dividerIndex: number,
    delta: number,
    containerWidth: number,
    gap = splitGap,
    minimum = minimumCardWidth,
): number[] {
    const shares = normalizedFractions(fractions);
    if (shares.length < 2 || dividerIndex < 0 || dividerIndex >= shares.length - 1) return shares;
    const available = availableWidth(containerWidth, shares.length, gap);
    if (available <= 0) return shares;
    const floor = Math.max(0, minimum);
    const pairWidth = available * (shares[dividerIndex]! + shares[dividerIndex + 1]!);
    if (pairWidth < floor * 2) return shares;
    const leading = available * shares[dividerIndex]!;
    const resolved = Math.min(Math.max(leading + delta, floor), pairWidth - floor);
    shares[dividerIndex] = resolved / available;
    shares[dividerIndex + 1] = (pairWidth - resolved) / available;
    return shares;
}
