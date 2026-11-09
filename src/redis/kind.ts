export enum KeyKind {
    String = 0,
    List = 1,
    Hash = 2,
    Set = 3,
    ZSet = 4,
}

export const KIND_NAME: Record<KeyKind, string> = {
    [KeyKind.String]: 'string',
    [KeyKind.List]: 'list',
    [KeyKind.Hash]: 'hash',
    [KeyKind.Set]: 'set',
    [KeyKind.ZSet]: 'zset',
}
