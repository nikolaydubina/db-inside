import type { StoryDef } from '../types'
import { REDIS_PUBSUB_STORY } from './pubsub'
import { REDIS_TRAVERSAL_STORY } from './traversal'
import { REDIS_ZSET_STORY } from './zset'
import { REDIS_HASH_STORY } from './hash'
import { REDIS_INLINE_STORY } from './inline'
import { REDIS_RAW_STORY } from './raw'

export const REDIS_STORIES: StoryDef[] = [
    REDIS_PUBSUB_STORY,
    REDIS_TRAVERSAL_STORY,
    REDIS_ZSET_STORY,
    REDIS_HASH_STORY,
    REDIS_INLINE_STORY,
    REDIS_RAW_STORY,
]

export {
    REDIS_PUBSUB_STORY,
    REDIS_TRAVERSAL_STORY,
    REDIS_ZSET_STORY,
    REDIS_HASH_STORY,
    REDIS_INLINE_STORY,
    REDIS_RAW_STORY,
}
