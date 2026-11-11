import type { StoryDef } from '../types'
import { QUEUE_STORY } from './queue'
import { WAL_STORY } from './wal'
import { BTREE_STORY } from './btree'
import { GIN_STORY } from './gin'
import { BRIN_STORY } from './brin'
import { HASH_STORY } from './hash'

export const POSTGRESQL_STORIES: StoryDef[] = [
    QUEUE_STORY,
    WAL_STORY,
    BTREE_STORY,
    GIN_STORY,
    BRIN_STORY,
    HASH_STORY,
]

export { QUEUE_STORY, WAL_STORY, BTREE_STORY, GIN_STORY, BRIN_STORY, HASH_STORY }
