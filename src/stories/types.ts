import * as THREE from 'three'
import type { EngineSim, SimStats } from '../postgresql/sim'
import { RedisBigKind, RedisReadOp } from '../redis/values'
import { Stage } from '../core/stage'
import { Db, DbScope } from '../core/db'
import type { PostgresqlIndexKind } from '../postgresql/indexes'

export type StoryFacts = Pick<
    SimStats,
    | 'connections'
    | 'maxConnections'
    | 'busyBackends'
    | 'buffered'
    | 'queued'
    | 'rps'
    | 'queries'
    | 'walBytes'
    | 'walSegments'
    | 'walPending'
> & {
    rdKeys: number
    rdOps: number
    rdRps: number
    bigKeys: number
    hotKeys: number

    rdSubs: number

    rdFanouts: number

    rdPhase: Stage | null

    rdStopGap: number | null

    rdCursor: { kind: string; step: number; steps: number } | null

    idxKind: PostgresqlIndexKind | null
    idxStage: Stage | null
    idxPages: number
    idxDisk: number
    idxHits: number
    idxHeap: number
    idxTuples: number
    idxGap: number | null
}

export interface StorySubject {
    id: string
    box: THREE.Box3

    object?: THREE.Object3D
}

export interface StoryScene {
    overview(): THREE.Box3

    ports(): THREE.Box3

    executing(): StorySubject | null

    valid(id: string): boolean

    walRun(): THREE.Box3

    walBuffers(): THREE.Box3

    walHead(): StorySubject | null

    redisRide?: () => StorySubject | null

    indexRide?: () => StorySubject | null
}

export interface StoryStep {
    title: string
    body: string

    view?: string

    subject?: (scene: StoryScene) => StorySubject | null

    dir?: [number, number, number]
    fov?: number

    padding?: number

    dist?: number

    lookShift?: [number, number, number]

    send?: number

    tap?: Db

    publish?: boolean

    subscribe?: boolean

    big?: RedisBigKind

    op?: RedisReadOp

    idx?: PostgresqlIndexKind

    cold?: boolean

    raw?: true

    sustainWhileOpen?: boolean

    delay?: number

    packetScale?: number

    act?: (sim: EngineSim) => void

    speed?: number

    freezeAt?: Stage

    freezeAtStep?: number

    assert?: (c: StoryFacts) => string | null

    expect: (c: StoryFacts) => boolean

    waitFor: string

    track?: boolean

    sustain?: number
}

export interface StoryDef {
    id: string
    label: string
    hint: string

    db?: DbScope
    steps: StoryStep[]
}
