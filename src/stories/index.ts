import type { StoryDef } from './types'
import { QUEUE_STORY } from './queue'
import { WAL_STORY } from './wal'
import { REDIS_PUBSUB_STORY } from './redis-pubsub'
import { REDIS_TRAVERSAL_STORY } from './redis-traversal'
import { REDIS_ZSET_STORY } from './redis-zset'
import { REDIS_HASH_STORY } from './redis-hash'
import { REDIS_INLINE_STORY } from './redis-inline'

/**
 * The stories, in the order the panel lists them. One file per story beside this
 * one: a story is a piece of writing about one part of the server, and it should
 * be possible to read it without scrolling past three other subjects.
 */
export const STORIES: StoryDef[] = [
    {
        id: 'queue',
        label: 'too many requests',
        hint: 'what happens when more queries arrive than the connections can run',
        steps: QUEUE_STORY,
    },
    {
        id: 'wal',
        label: 'the write-ahead log',
        hint: 'why a change is written to a log before the page it changes',
        steps: WAL_STORY,
    },
    {
        id: 'pubsub',
        label: 'pub/sub',
        db: 'redis',
        hint: 'no keys, no storage, pure fan-out to N sockets: a path that never touches the keyspace or the log',
        steps: REDIS_PUBSUB_STORY,
    },
    {
        id: 'traversal',
        label: 'pointer chases',
        db: 'redis',
        hint: 'what a read follows: bucket, entry, then the pages a big value’s nodes were allocated on',
        steps: REDIS_TRAVERSAL_STORY,
    },
    {
        id: 'zset',
        label: 'zset lookups',
        db: 'redis',
        hint: 'one member in the dict, or a range down the tower: two reads of the same value',
        steps: REDIS_ZSET_STORY,
    },
    {
        id: 'hash',
        label: 'hash lookups',
        db: 'redis',
        hint: 'HGET is one bucket; HGETALL walks every bucket — the same value, two different jobs',
        steps: REDIS_HASH_STORY,
    },
    {
        id: 'inline',
        label: 'inline values',
        db: 'redis',
        hint: 'the values that end inside their own 16-byte object: int, embstr, shared ints',
        steps: REDIS_INLINE_STORY,
    },
]

export * from './types'
export { PLANNED_STORIES } from './planned'
export { createStory } from './runner'
export type { Story, StoryOptions } from './runner'
export { QUEUE_STORY } from './queue'
export { WAL_STORY } from './wal'
export { REDIS_PUBSUB_STORY } from './redis-pubsub'
export { REDIS_TRAVERSAL_STORY } from './redis-traversal'
export { REDIS_ZSET_STORY } from './redis-zset'
export { REDIS_HASH_STORY } from './redis-hash'
export { REDIS_INLINE_STORY } from './redis-inline'
