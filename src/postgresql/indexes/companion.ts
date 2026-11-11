import { Companion } from '../../core/companion'
import { PALETTE } from '../layout'
import { Stage } from '../../core/stage'
import {
    applyBeat,
    POSTGRESQL_INDEX_LABEL,
    PostgresqlIndexKind,
    type IndexStructure,
} from './structure'
import type * as THREE from 'three'

export interface IndexCompanionState {
    kind: PostgresqlIndexKind | null
    stage: Stage | null
    say: string
    carried: boolean
}

export class PostgresqlIndexCompanion {
    private readonly shell: Companion
    private kind: PostgresqlIndexKind | null = null
    private stage: Stage | null = null
    private say = ''

    constructor(
        parent: THREE.Object3D,
        private readonly structures: Record<PostgresqlIndexKind, IndexStructure>,
    ) {
        this.shell = new Companion({
            parent,
            width: 1.55,
            height: 1.0,
            depth: 0.7,
            color: PALETTE.violet,
            lift: 0.34,
        })
    }

    get carried() {
        return this.shell.carried
    }

    state(): IndexCompanionState {
        return { kind: this.kind, stage: this.stage, say: this.say, carried: this.carried }
    }

    attach(kind: PostgresqlIndexKind, packet: THREE.Object3D) {
        if (this.kind !== kind) {
            this.shell.setBody(this.structures[kind].group)
            this.kind = kind
            this.stage = null
            this.say = ''
            this.shell.say(`${POSTGRESQL_INDEX_LABEL[kind]} · ${describe(kind)}`)
        }
        this.shell.attach(packet)
    }

    release() {
        this.shell.release()
        this.kind = null
        this.stage = null
        this.say = ''
    }

    beat(stage: Stage) {
        if (!this.kind) return
        this.stage = stage
        applyBeat(this.structures[this.kind], stage)
        const say = this.structures[this.kind].beats[stage]?.say
        if (!say) return
        this.say = say
        this.shell.say(say)
    }
}

const describe = (kind: PostgresqlIndexKind) =>
    kind === PostgresqlIndexKind.Btree
        ? 'root → internal → leaf'
        : kind === PostgresqlIndexKind.Gin
          ? 'element → posting list → bitmap'
          : kind === PostgresqlIndexKind.Brin
            ? 'min/max per 128 pages'
            : 'meta → bucket → overflow'
