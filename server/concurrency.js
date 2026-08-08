// Concurrency control for the price scraper.
//
// Two tiers share one server-wide scheduler:
//
//  • PUBLIC  — keyless traffic. Capped to MAX_PUBLIC_CONCURRENCY simultaneous
//            scrapes (with a bounded wait queue). This is the overload guard:
//            even if a client opens many sockets to dodge the per-socket rate
//            limit, only this many public Puppeteer browsers ever run at once.
//
//  • PRIVATE — keyed traffic. Runs with EXCLUSIVE priority: at most one private
//            scrape executes at a time, and while a private scrape is running
//            (or waiting to run) every public scrape is held. Public requests
//            yield at ISIN boundaries — an in-flight public scrape finishes its
//            current ISIN, then parks until the private work is done and resumes
//            with the rest. Private therefore never shares the machine with
//            public traffic and never overlaps another private run.

// Both env vars keep their original names for deployment compatibility.
const MAX_PUBLIC_CONCURRENCY = Number(process.env.FREE_PRICE_CONCURRENCY || 2);
const MAX_PUBLIC_QUEUE = Number(process.env.FREE_PRICE_QUEUE || 30);

// --- public-tier concurrency cap --------------------------------------------
let publicSlots = 0;
const publicSlotQueue = [];

export function acquirePublicSlot() {
    return new Promise((resolve, reject) => {
        if (publicSlots < MAX_PUBLIC_CONCURRENCY) {
            publicSlots++;
            return resolve();
        }
        if (publicSlotQueue.length >= MAX_PUBLIC_QUEUE) {
            return reject(new Error('Server busy with public-tier requests, please retry in a moment.'));
        }
        publicSlotQueue.push(resolve);
    });
}

export function releasePublicSlot() {
    const next = publicSlotQueue.shift();
    if (next) {
        // Hand the slot straight to the next waiter (publicSlots stays the same).
        next();
    } else {
        publicSlots = Math.max(0, publicSlots - 1);
    }
}

// --- private-tier exclusivity gate ------------------------------------------
let privateActive = false;       // a private scrape is executing right now
let privatePending = 0;          // private scrapes waiting to execute
let privateChainTail = Promise.resolve(); // serializes private runs (one at a time)

let publicRunning = 0;           // public scrapes touching an ISIN at this instant
const publicGateWaiters = [];    // public requests parked until private clears
const publicDrainWaiters = [];   // private runs waiting for publicRunning to hit 0

function privateBlocking() {
    return privateActive || privatePending > 0;
}

// Called by public requests before opening a browser and again before each ISIN.
// Resolves immediately when no private run is active/pending, otherwise parks
// the caller until the private work clears.
export function waitWhilePrivate() {
    if (!privateBlocking()) return Promise.resolve();
    return new Promise((resolve) => publicGateWaiters.push(resolve));
}

function wakePublicWaiters() {
    while (publicGateWaiters.length) publicGateWaiters.shift()();
}

// Bracket the actual scrape of a single public ISIN, so a waiting private run
// can tell when all in-flight public work has yielded.
export function beginPublicWork() {
    publicRunning++;
}

export function endPublicWork() {
    publicRunning = Math.max(0, publicRunning - 1);
    if (publicRunning === 0) {
        while (publicDrainWaiters.length) publicDrainWaiters.shift()();
    }
}

function waitForPublicDrain() {
    if (publicRunning === 0) return Promise.resolve();
    return new Promise((resolve) => publicDrainWaiters.push(resolve));
}

// Run `task` with exclusive private-tier priority. As soon as this is called,
// new public scrapes are blocked; we then wait for any in-flight public ISIN to
// finish, run the task alone, and finally release — resuming the next private
// run (if any) or the parked public requests.
export async function runExclusivePrivate(task) {
    privatePending++;

    // Serialize against other private runs: take our place in the chain.
    const previous = privateChainTail;
    let releaseChain;
    privateChainTail = new Promise((r) => (releaseChain = r));
    await previous;

    privateActive = true;
    privatePending--;

    // Let any public ISIN currently mid-scrape finish, then we own the machine.
    await waitForPublicDrain();

    try {
        return await task();
    } finally {
        privateActive = false;
        releaseChain();
        // Only release the public traffic when no private run remains queued/active.
        if (!privateBlocking()) wakePublicWaiters();
    }
}

// Inspection hook for tests.
export function _stats() {
    return {
        publicSlots,
        publicSlotQueue: publicSlotQueue.length,
        publicRunning,
        privateActive,
        privatePending,
        publicGateWaiters: publicGateWaiters.length,
    };
}
