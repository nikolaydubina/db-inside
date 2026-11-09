import * as THREE from 'three'
import type { EngineSim, SimStats } from '../postgresql/sim'
import type { BigKind } from '../redis/redis'

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

    rdPhase: RidePhase

    rdStopGap: number | null

    rdCursor: { kind: string; step: number; steps: number } | null
}

export type RidePhase =
    | 'socket'
    | 'channel'
    | 'delivered'
    | 'bucket'
    | 'page'
    | 'entry'
    | 'value'
    | 'inner'
    | 'field'
    | 'node'
    | 'hop'
    | 'reply'
    | null

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

    tap?: 'postgres' | 'redis'

    publish?: boolean

    subscribe?: boolean

    big?: BigKind

    op?: 'point' | 'walk' | 'object'

    raw?: true

    sustainWhileOpen?: boolean

    delay?: number

    packetScale?: number

    act?: (sim: EngineSim) => void

    speed?: number

    freezeAt?: Exclude<RidePhase, null>

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

    db?: 'postgres' | 'redis' | 'both'
    steps: StoryStep[]
}
