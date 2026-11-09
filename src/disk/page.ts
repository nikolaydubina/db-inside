export class PageBlock {
    constructor(
        readonly label: string,

        readonly bytes: number,

        readonly w: number,
        readonly h: number,
        readonly d: number,
    ) {}

    centreY(floorY: number, lift: number) {
        return floorY + lift + this.h / 2
    }

    topY(floorY: number, lift: number) {
        return floorY + lift + this.h
    }

    fits(small: PageBlock) {
        return this.bytes / small.bytes
    }
}

export const PAGE_8K = new PageBlock('8 kB page', 8192, 0.46, 0.23, 0.23)

export const PAGE_4K = new PageBlock('4 kB block', PAGE_8K.bytes / 2, 0.23, 0.23, 0.23)

export const CELL_PITCH = 0.25

export const PAGE_PITCH = CELL_PITCH * 2

export const BLOCKS_PER_PAGE = PAGE_8K.fits(PAGE_4K)

export const cellAddress = (cellRow: number, cellCol: number, cols: number): number =>
    (cellRow * cols + cellCol) * PAGE_4K.bytes

export const pageAddress = (pageRow: number, pageCol: number, pageCols: number): number =>
    (pageRow * pageCols + pageCol) * PAGE_8K.bytes
