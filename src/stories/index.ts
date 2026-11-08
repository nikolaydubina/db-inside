import type { StoryDef } from './types'
import { QUEUE_STORY } from './queue'
import { WAL_STORY } from './wal'
import { REDIS_SKEW_STORY } from './redis-skew'
import { REDIS_PUBSUB_STORY } from './redis-pubsub'

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
        id: 'skew',
        label: 'one big value',
        db: 'redis',
        hint: 'what a large list, hash or sorted set looks like — and why the one thread makes it hurt',
        steps: REDIS_SKEW_STORY,
    },
    {
        id: 'pubsub',
        label: 'pub/sub',
        db: 'redis',
        hint: 'no keys, no storage, pure fan-out to N sockets: a path that never touches the keyspace or the log',
        steps: REDIS_PUBSUB_STORY,
    },
]

export * from './types'
export { PLANNED_STORIES } from './planned'
export { createStory } from './runner'
export type { Story, StoryOptions } from './runner'
export { QUEUE_STORY } from './queue'
export { WAL_STORY } from './wal'
export { REDIS_SKEW_STORY } from './redis-skew'
export { REDIS_PUBSUB_STORY } from './redis-pubsub'
