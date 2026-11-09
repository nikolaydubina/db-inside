import * as THREE from 'three'

export interface DiskSnapshot {
    disk: THREE.InstancedMesh
    aofHead: number
    aofOrder: number[]
    aofBlockPos(k: number): THREE.Vector3
    aofEdge: { w: number; d: number }
    rdbLen: number
    rdbOrder: number[]
    rewriting: boolean
    stagingId(k: number): number
    cols: number
    rows: number
    cell: number
}

export function verifyDisk(s: DiskSnapshot): string[] {
    const bad: string[] = []
    const m = s.disk.instanceMatrix.array
    const scale = (id: number) => m[id * 16 + 5]
    const pos = (id: number) => new THREE.Vector3(m[id * 16 + 12], m[id * 16 + 13], m[id * 16 + 14])

    const aofDrawn = new Set<number>()
    for (let k = 0; k <= s.aofHead; k++) {
        const id = s.aofOrder[k]
        if (id === undefined) {
            bad.push(`log block ${k} has no floor slot`)
            continue
        }
        if (Math.abs(scale(id) - 1) > 2e-3) {
            bad.push(`log block ${k} (id ${id}) should be drawn, scale is ${scale(id).toFixed(3)}`)
        }
        const want = s.aofBlockPos(k)
        if (pos(id).distanceTo(want) > 1e-3) {
            const at = (v: THREE.Vector3) =>
                v
                    .toArray()
                    .map((n) => n.toFixed(2))
                    .join(', ')
            bad.push(`log block ${k} sits at ${at(pos(id))}, expected ${at(want)}`)
        }
        aofDrawn.add(id)
    }

    for (let k = s.aofHead + 1; k <= Math.min(s.aofHead + 4, s.aofOrder.length - 1); k++) {
        const id = s.aofOrder[k]
        if (scale(id) > 1e-2) bad.push(`log block ${k} is drawn, but the file ends at ${s.aofHead}`)
    }

    for (let k = 0; k < s.rdbLen; k++) {
        const id = s.rdbOrder[k]
        if (scale(id) < 0.1) bad.push(`base block ${k} (id ${id}) is missing`)
    }

    for (let k = s.rdbLen; k < Math.min(s.rdbLen + 3, s.rdbOrder.length); k++) {
        const id = s.rdbOrder[k]
        if (scale(id) > 1e-2)
            bad.push(`base block ${k} is drawn, but the file ends at ${s.rdbLen - 1}`)
    }

    for (let k = 0; k < s.rdbLen; k++) {
        if (aofDrawn.has(s.rdbOrder[k])) bad.push(`block ${k} of the base file is also in the log`)
    }

    const col = s.disk.instanceColor?.array
    if (col) {
        const lit = (id: number) => col[id * 3] + col[id * 3 + 1] + col[id * 3 + 2]
        let blackAof = 0
        let blackRdb = 0
        for (let k = 0; k <= s.aofHead; k++) {
            const id = s.aofOrder[k]
            if (id !== undefined && scale(id) > 0.5 && lit(id) < 1e-4) blackAof++
        }
        for (let k = 0; k < s.rdbLen; k++) {
            const id = s.rdbOrder[k]
            if (scale(id) > 0.1 && lit(id) < 1e-4) blackRdb++
        }
        if (blackAof > 0) bad.push(`${blackAof} block(s) of the log are drawn but black`)
        if (blackRdb > 0) bad.push(`${blackRdb} block(s) of the base file are drawn but black`)
    }

    if (s.aofHead >= 0 && s.aofOrder.length > 0) {
        let minC = s.cols
        let maxC = -1
        let minR = s.rows
        let maxR = -1
        for (let k = 0; k <= s.aofHead; k++) {
            const id = s.aofOrder[k]
            if (id === undefined) continue
            const c = id % s.cols
            const r = Math.floor(id / s.cols)
            minC = Math.min(minC, c)
            maxC = Math.max(maxC, c)
            minR = Math.min(minR, r)
            maxR = Math.max(maxR, r)
        }
        const wantW = (maxC - minC + 1) * s.cell
        const wantD = (maxR - minR + 1) * s.cell
        if (Math.abs(s.aofEdge.w - wantW) > 1e-3) {
            bad.push(`log cage width ${s.aofEdge.w.toFixed(2)} ≠ the file's ${wantW.toFixed(2)}`)
        }
        if (Math.abs(s.aofEdge.d - wantD) > 1e-3) {
            bad.push(`log cage depth ${s.aofEdge.d.toFixed(2)} ≠ the file's ${wantD.toFixed(2)}`)
        }
    }

    if (!s.rewriting) {
        for (let k = 0; k < 16; k++) {
            if (scale(s.stagingId(k)) > 1e-2) {
                bad.push(`staging block ${k} is still drawn after the rewrite finished`)
            }
        }
    }

    return bad
}
