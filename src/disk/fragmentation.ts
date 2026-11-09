export interface FragmentationLaw {
    packed?: number

    allFree?: number

    maxFree?: number

    rng?: () => number
}

const DEFAULTS = { packed: 0.6, allFree: 0.8, maxFree: 0.9 }

export function freeChance(col: number, cols: number, law: FragmentationLaw = {}): number {
    const { packed, allFree, maxFree } = { ...DEFAULTS, ...law }
    const t = 1 - col / (cols - 1)
    if (t >= allFree) return 1
    if (t <= packed) return 0
    return ((t - packed) / (allFree - packed)) * maxFree
}

export function freeAt(col: number, cols: number, law: FragmentationLaw = {}): boolean {
    const rng = law.rng ?? Math.random
    return rng() < freeChance(col, cols, law)
}

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
