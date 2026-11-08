/**
 * The two block sizes the scene draws, and the one lattice they share.
 *
 * The fundamental lattice cell is the filesystem allocation unit: 4 kB, drawn
 * as a SQUARE. A postgres 8 kB page is TWO cells wide — the page is the
 * odd-sized block, not the grid. That keeps the address lattice independent of
 * any one database's page size: 4K = 1 cell, 8K = 2, 16K = 4, 32K = 8.
 *
 * Pure numbers and units: no three.js, no cage. Both disk layouts import this,
 * so the two sizes cannot drift apart.
 */
export class PageBlock {
    constructor(
        /** What the scene calls it, so a card or a log line can say it. */
        readonly label: string,
        /** How many bytes one block holds. */
        readonly bytes: number,
        /** Drawn extent, in the scene's units. */
        readonly w: number,
        readonly h: number,
        readonly d: number,
    ) { }

    /** Centre height of a block resting on a floor, lifted by the shared hair. */
    centreY(floorY: number, lift: number) {
        return floorY + lift + this.h / 2
    }

    /** Top face of a block resting on a floor — where arrows are allowed to land. */
    topY(floorY: number, lift: number) {
        return floorY + lift + this.h
    }

    /** How many of `small` fit in this block. */
    fits(small: PageBlock) {
        return this.bytes / small.bytes
    }
}

/** One 8 kB page: Postgres's unit. It is TWO 4 kB cubes wide, one cube deep. */
export const PAGE_8K = new PageBlock('8 kB page', 8192, 0.46, 0.23, 0.23)

/**
 * One 4 kB filesystem block: exactly one square address cell.
 *
 * The cell is 0.25 × 0.25; the block is inset by the usual hair, so it is
 * 0.23 × 0.23. Height is shared with every other block. This is the only unit
 * a redis file has.
 */
export const PAGE_4K = new PageBlock(
    '4 kB block',
    PAGE_8K.bytes / 2,
    0.23,
    0.23,
    0.23,
)

/** Side of one square address cell, in world units. */
export const CELL_PITCH = 0.25

/** X pitch of an 8 kB page: two cells. */
export const PAGE_PITCH = CELL_PITCH * 2

/** How many 4 kB cells one 8 kB page covers, along x. */
export const BLOCKS_PER_PAGE = PAGE_8K.fits(PAGE_4K)

/**
 * On a floor, XZ is a picture of ONE contiguous byte range:
 *
 *     address(cellRow, cellCol, cols) = (cellRow * cols + cellCol) * 4 kB
 *
 * x is the major axis (the floor is wide), z is the next row of cells. An 8 kB
 * page is two adjacent cells along x, so filling x first also fills a page
 * before moving to the next one. The plane is the picture; the address space is
 * the thing being modelled.
 */
export const cellAddress = (cellRow: number, cellCol: number, cols: number): number =>
    (cellRow * cols + cellCol) * PAGE_4K.bytes

/** Byte range covered by an 8 kB page at (pageRow, pageCol). */
export const pageAddress = (pageRow: number, pageCol: number, pageCols: number): number =>
    (pageRow * pageCols + pageCol) * PAGE_8K.bytes
