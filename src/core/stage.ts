export const enum Stage {
    Socket = 1,
    Channel,
    Delivered,
    Bucket,
    Page,
    Entry,
    Value,
    Inner,
    Field,
    Node,
    Hop,
    Reply,

    Idle,
    SocketIn,
    Parse,
    Plan,
    Exec,
    Root,
    Internal,
    Leaf,
    Tid,
    Heap,
    Meta,
    Overflow,
    Summaries,
    Prune,
    Posting,
    Bitmap,
    Slot,
    Disk,
}

export const STAGE_NAME: Record<Stage, string> = {
    [Stage.Socket]: 'socket',
    [Stage.Channel]: 'channel',
    [Stage.Delivered]: 'delivered',
    [Stage.Bucket]: 'bucket',
    [Stage.Page]: 'page',
    [Stage.Entry]: 'entry',
    [Stage.Value]: 'value',
    [Stage.Inner]: 'inner',
    [Stage.Field]: 'field',
    [Stage.Node]: 'node',
    [Stage.Hop]: 'hop',
    [Stage.Reply]: 'reply',
    [Stage.Idle]: 'idle',
    [Stage.SocketIn]: 'socket-in',
    [Stage.Parse]: 'parse',
    [Stage.Plan]: 'plan',
    [Stage.Exec]: 'exec',
    [Stage.Slot]: 'slot',
    [Stage.Disk]: 'disk',
    [Stage.Root]: 'root',
    [Stage.Internal]: 'internal',
    [Stage.Leaf]: 'leaf',
    [Stage.Tid]: 'tid',
    [Stage.Heap]: 'heap',
    [Stage.Meta]: 'meta',
    [Stage.Overflow]: 'overflow',
    [Stage.Summaries]: 'summaries',
    [Stage.Prune]: 'prune',
    [Stage.Posting]: 'posting',
    [Stage.Bitmap]: 'bitmap',
}

export type StageListener = (stage: Stage, ride: number) => void

export interface StageHub {
    add(listener: StageListener): () => void
    emit(stage: Stage, ride: number): void
}

export function stageHub(): StageHub {
    const listeners = new Set<StageListener>()
    return {
        add(listener) {
            listeners.add(listener)
            return () => void listeners.delete(listener)
        },
        emit(stage, ride) {
            for (const listener of [...listeners]) listener(stage, ride)
        },
    }
}
