import * as THREE from 'three'
import { PostgresqlIndexCompanion } from './companion'
import { buildBtree } from './btree'
import { buildGin } from './gin'
import { buildBrin } from './brin'
import { buildHash } from './hash'
import { PostgresqlIndexKind } from './structure'
import type { IndexStructure } from './structure'

export {
    PageMark,
    POSTGRESQL_INDEX_LABEL,
    POSTGRESQL_INDEX_NAME,
    PostgresqlIndexKind,
} from './structure'
export type { IndexBeat, IndexBeats, IndexStructure } from './structure'
export type { IndexCompanionState } from './companion'

export const createPostgresqlIndexCompanion = (parent: THREE.Object3D) => {
    const structures: Record<PostgresqlIndexKind, IndexStructure> = {
        [PostgresqlIndexKind.Btree]: buildBtree(),
        [PostgresqlIndexKind.Gin]: buildGin(),
        [PostgresqlIndexKind.Brin]: buildBrin(),
        [PostgresqlIndexKind.Hash]: buildHash(),
    }
    return new PostgresqlIndexCompanion(parent, structures)
}

export type PostgresqlIndexCompanionHandle = PostgresqlIndexCompanion
