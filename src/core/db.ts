export const enum Db {
    Postgres = 1,
    Redis = 2,
}

export const DB_NAME: Record<Db, string> = {
    [Db.Postgres]: 'postgres',
    [Db.Redis]: 'redis',
}

export const DB_LABEL: Record<Db, string> = {
    [Db.Postgres]: 'PostgreSQL',
    [Db.Redis]: 'Redis',
}

export const enum DbScope {
    Postgres = 1,
    Redis = 2,
    Both = 3,
}

export const DB_SCOPE_NAME: Record<DbScope, string> = {
    [DbScope.Postgres]: 'postgres',
    [DbScope.Redis]: 'redis',
    [DbScope.Both]: 'both',
}

export const dbFromName = (name: string | undefined): Db | null =>
    name === DB_NAME[Db.Postgres] ? Db.Postgres : name === DB_NAME[Db.Redis] ? Db.Redis : null

export const inScope = (scope: DbScope, db: Db) =>
    scope === DbScope.Both || (scope === DbScope.Postgres ? db === Db.Postgres : db === Db.Redis)
