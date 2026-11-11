import * as THREE from 'three'
import { Db } from './core/db'

export type ShareDb = Db

export interface Address {
    db: ShareDb

    slug: string
}

const dbOf = (seg: string): Db | null => {
    if (seg === 'postgresql' || seg === 'postgres' || seg === 'psql') return Db.Postgres
    if (seg === 'redis') return Db.Redis
    return null
}

export function addressFromPath(pathname: string): Address | null {
    const segs = pathname
        .split('/')
        .filter(Boolean)
        .map((s) => s.toLowerCase())
    if (segs.length === 0 || segs.length > 2) return null
    const db = dbOf(segs[0])
    if (!db) return null
    return { db, slug: segs[1] ?? '' }
}

export function pathFor(db: Db, slug = ''): string {
    const base = db === Db.Postgres ? '/postgresql' : '/redis'
    return slug ? `${base}/${slug}` : base
}

const round = (n: number) => Math.round(n * 100) / 100
const triple = (v: THREE.Vector3) => `${round(v.x)},${round(v.y)},${round(v.z)}`

export function encodePose(pos: THREE.Vector3, target: THREE.Vector3, fov: number): string {
    return `${triple(pos)}~${triple(target)}~${round(fov)}`
}

export function decodePose(
    raw: string | null,
): { pos: THREE.Vector3; target: THREE.Vector3; fov: number } | null {
    if (!raw) return null
    const parts = raw.split('~')
    if (parts.length !== 3) return null
    const readTriple = (s: string) => {
        const n = s.split(',').map(Number)
        return n.length === 3 && n.every((v) => Number.isFinite(v)) ? n : null
    }
    const pos = readTriple(parts[0])
    const target = readTriple(parts[1])
    const fov = Number(parts[2])
    if (!pos || !target || !Number.isFinite(fov) || fov <= 5 || fov >= 120) return null
    return {
        pos: new THREE.Vector3(pos[0], pos[1], pos[2]),
        target: new THREE.Vector3(target[0], target[1], target[2]),
        fov,
    }
}
