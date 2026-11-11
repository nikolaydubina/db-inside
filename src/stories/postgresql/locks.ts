import type { StoryDef, StoryStep } from '../types'
import { ANCHOR, V } from '../../postgresql/layout'

const rack = (s: Parameters<NonNullable<StoryStep['subject']>>[0]) => s.lockRack()

const RACK = { subject: rack } satisfies Partial<StoryStep>

const USERS = 'users'

// The relation's own pages on the plate. Read at act time — ANCHOR.heap is only moved onto
// the real region once the plate is built, which is after this module is loaded.
const usersAt = () => V(ANCHOR.heap.x, ANCHOR.heap.y + 0.45, ANCHOR.heap.z)

const steps: StoryStep[] = [
    {
        title: 'three statements, one entry on one table',
        body: 'Nothing is held at the socket: all three statements are accepted, and each one is parsed and planned in full before anything can block. What the lock protects is the relation, and the request goes in when the executor opens it — that is the instant the packet leaves the pipeline for the table. The lock table is keyed by what is being locked, so three statements on users do not make three entries: they make one entry, the block, with a pip on its front for each backend holding it. AccessShare conflicts with nothing but the exclusive modes, so the three of them share and none queues.',
        ...RACK,
        send: 0,
        delay: 0,
        act: (sim) => {
            sim.clearLocks()
            sim.setLockStory(USERS, usersAt())
            void sim.runLockedReaders(3)
        },
        expect: (c) => c.locksHeld === 1 && c.locksHolding >= 3 && c.locksWaiting === 0,
        waitFor: 'three backends on one entry',
    },
    {
        title: 'the fourth statement cannot get in',
        body: 'ALTER TABLE opens the same relation in AccessExclusive, which shares with nobody. Its parse and its plan still completed — the stop is at the executor, on the entry, not on the way in — and what you see parked outside is that statement’s own packet, not a separate token: it has nowhere to go until the entry is free. In pg_locks this backend is a row with granted = false, and its wait_event is Lock. The three reads are unaffected; the queue behind the ALTER now includes every new reader of this table as well.',
        ...RACK,
        send: 0,
        delay: 900,
        act: (sim) => {
            void sim.runStatementLock('AccessExclusive', { hold: true, tag: 'S4' })
        },
        expect: (c) => c.locksWaiting === 1 && c.locksHeld === 1 && c.locksHolding >= 3,
        waitFor: 'the ALTER parked at the entry',
    },
    {
        title: 'COMMIT releases, and the queue moves',
        body: 'The three readers commit, so their pips go and the entry has no holders left — it is empty now, and the entry itself is the thing the waiter was queued on. The moment it is free the ALTER is granted without ever re-parsing: the same packet continues from where it stopped, opens the relation in the mode it asked for, and becomes one block with one pip. Hooks last until the transaction ends, which is why the whole queue behind one idle session waits for exactly this moment.',
        ...RACK,
        send: 0,
        delay: 1100,
        act: (sim) => {
            sim.releaseLocks()
        },
        expect: (c) => c.locksHeld === 1 && c.locksHolding === 1 && c.locksWaiting === 0,
        waitFor: 'the ALTER holding the entry the readers left',
    },
    {
        title: 'row locks never reach this table',
        body: 'An UPDATE takes one row-exclusive entry for the statement and then locks its rows by writing a bit into each tuple header — the pages light up where the rows changed, and the rack keeps that single block and nothing else. A million-row update locks a million rows and adds no entries. Two sessions wanting the same row do wait, but on the holder’s transaction id: one entry keyed by the transaction, covering every row it has locked. What exhausts this table is never data — it is locking a thousand relations in one transaction, and the failure is out of shared memory.',
        ...RACK,
        send: 0,
        delay: 900,
        act: (sim) => {
            sim.releaseLocks()
            sim.holdLock(USERS, 'RowExclusive', usersAt())
            sim.touchRows(5)
        },
        expect: (c) => c.locksHeld === 1 && c.locksHolding === 1 && c.locksWaiting === 0,
        waitFor: 'the pages changing while the rack keeps one entry',
    },
]

export const LOCKS_STORY: StoryDef = {
    id: 'locks',
    label: 'locks and waiting',
    hint: 'who holds the table, and who is queued behind them',
    steps,
}
