export const enum RedisKeyKind {
    String = 0,
    List = 1,
    Hash = 2,
    Set = 3,
    ZSet = 4,
}

export const REDIS_KEY_KIND_NAME: Record<RedisKeyKind, string> = {
    [RedisKeyKind.String]: 'string',
    [RedisKeyKind.List]: 'list',
    [RedisKeyKind.Hash]: 'hash',
    [RedisKeyKind.Set]: 'set',
    [RedisKeyKind.ZSet]: 'zset',
}
