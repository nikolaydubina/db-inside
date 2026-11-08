/**
 * Fragmentation as a teaching shape, not an allocator.
 *
 * Real storage has no linear XZ plane, and no filesystem decides free space
 * from a column index. What the floors show, and what this generates, is the
 * SHAPE of a used range: packed solid where writes arrive, holes increasing
 * outward, and an untouched tail at the far end. It makes the disk read as an
 * address space with free extents instead of as a uniform field.
 *
 * The law is a function of the address-major axis only. On these floors x is
 * wide and z is just the two 4 kB halves of a page, so that axis is x.
 */

export interface FragmentationLaw {
    /** Fraction of the range, from the packed edge, with no holes at all. */
    packed?: number
    /** Fraction at which the rest of the range is free. */
    allFree?: number
    /** Chance a slot is free at the far edge of the fragmented band. */
    maxFree?: number
    /** Injectable RNG, so a scene can be generated exactly for a screenshot. */
    rng?: () => number
}

const DEFAULTS = { packed: 0.6, allFree: 0.8, maxFree: 0.9 }

/**
 * Probability that the slot at `col` is free.
 *
 * `t = 1 - col / (cols - 1)` is the distance from the packed edge: t = 1 at
 * column 0 (the untouched end) and t = 0 at the last column (the packed end).
 * Past `packed` the chance rises linearly from 0 to `maxFree` at `allFree`,
 * and everything beyond `allFree` is free.
 */
export function freeChance(col: number, cols: number, law: FragmentationLaw = {}): number {
    const { packed, allFree, maxFree } = { ...DEFAULTS, ...law }
    const t = 1 - col / (cols - 1)
    if (t >= allFree) return 1
    if (t <= packed) return 0
    return ((t - packed) / (allFree - packed)) * maxFree
}

/** One sample of the law. Sample per slot, not once per column. */
export function freeAt(col: number, cols: number, law: FragmentationLaw = {}): boolean {
    const rng = law.rng ?? Math.random
    return rng() < freeChance(col, cols, law)
}

/** A whole field of free/used slots in the same shape the psql floor samples. */
export function fragmentationField(
    cols: number,
    rows: number,
    law: FragmentationLaw = {},
): boolean[][] {
    const field: boolean[][] = []
    for (let r = 0; r < rows; r++) {
        const row: boolean[] = []
        for (let c = 0; c < cols; c++) row.push(freeAt(c, cols, law))
        field.push(row)
    }
    return field
}
