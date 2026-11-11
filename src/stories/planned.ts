import { DbScope } from '../core/db'

export const PLANNED_STORIES: { label: string; hint: string; db?: DbScope }[] = [
    {
        label: 'a slot that pins the WAL',
        hint: 'an inactive replication slot stops the ring recycling: pg_wal grows until the disk fills',
    },
    {
        label: 'catalog bloat',
        hint: 'repeated create/alter/drop leaves dead tuples in pg_class and pg_attribute; VACUUM reuses the space but the files never shrink',
    },
    {
        label: 'a transaction that never ends',
        hint: 'an old xmin stops VACUUM everywhere: dead tuples pile up in every table and pg_xact cannot be truncated',
    },
    {
        label: 'multixact accumulation',
        hint: 'heavy SELECT … FOR SHARE concurrency grows pg_multixact/members, with its own wraparound hazard',
    },
    {
        label: 'a blocking command',
        hint: 'BLPOP does not stall the server: the client is parked and the thread moves on — unlike KEYS *, which does stall it',
        db: DbScope.Redis,
    },
    {
        label: 'MULTI / EXEC and Lua',
        hint: 'queued, then executed in one burst; and BUSY after lua-time-limit, the only reply of its kind redis sends',
        db: DbScope.Redis,
    },
    {
        label: 'replication and the backlog',
        hint: 'a replica, PSYNC, and the repl backlog — a fixed-size ring, the one buffer here whose policy is the opposite of a log that only grows',
        db: DbScope.Redis,
    },
    {
        label: 'eviction policy',
        hint: 'LRU/LFU sampling: maxmemory-samples keys, the least recently used of the sample, and whether keys with a TTL go first',
        db: DbScope.Redis,
    },
    {
        label: 'io-threads',
        hint: 'redis 6+ reads and writes sockets on several threads while command execution stays serial',
        db: DbScope.Redis,
    },
]
