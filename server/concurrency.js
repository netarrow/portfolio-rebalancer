// Concurrency control for the price scraper.
//
// Two tiers share one server-wide scheduler:
//
//  • FREE  — keyless traffic. Capped to MAX_FREE_CONCURRENCY simultaneous
//            scrapes (with a bounded wait queue). This is the overload guard:
//            even if a client opens many sockets to dodge the per-socket rate
//            limit, only this many free Puppeteer browsers ever run at once.
//
//  • PREMIUM — keyed traffic. Runs with EXCLUSIVE priority: at most one premium
//            scrape executes at a time, and while a premium scrape is running
//            (or waiting to run) every free scrape is held. Free requests yield
//            at ISIN boundaries — an in-flight free scrape finishes its current
//            ISIN, then parks until the premium work is done and resumes with
//            the rest. Premium therefore never shares the machine with free
//            traffic and never overlaps another premium.

const MAX_FREE_CONCURRENCY = Number(process.env.FREE_PRICE_CONCURRENCY || 2);
const MAX_FREE_QUEUE = Number(process.env.FREE_PRICE_QUEUE || 30);

// --- free-tier concurrency cap ---------------------------------------------
let freeSlots = 0;
const freeSlotQueue = [];

export function acquireFreeSlot() {
    return new Promise((resolve, reject) => {
        if (freeSlots < MAX_FREE_CONCURRENCY) {
            freeSlots++;
            return resolve();
        }
        if (freeSlotQueue.length >= MAX_FREE_QUEUE) {
            return reject(new Error('Server busy with free-tier requests, please retry in a moment.'));
        }
        freeSlotQueue.push(resolve);
    });
}

export function releaseFreeSlot() {
    const next = freeSlotQueue.shift();
    if (next) {
        // Hand the slot straight to the next waiter (freeSlots stays the same).
        next();
    } else {
        freeSlots = Math.max(0, freeSlots - 1);
    }
}

// --- premium exclusivity gate ----------------------------------------------
let premiumActive = false;       // a premium scrape is executing right now
let premiumPending = 0;          // premium scrapes waiting to execute
let premiumChainTail = Promise.resolve(); // serializes premium runs (one at a time)

let freeRunning = 0;             // free scrapes touching an ISIN at this instant
const freeGateWaiters = [];      // free requests parked until premium clears
const freeDrainWaiters = [];     // premium runs waiting for freeRunning to hit 0

function premiumBlocking() {
    return premiumActive || premiumPending > 0;
}

// Called by free requests before opening a browser and again before each ISIN.
// Resolves immediately when no premium is active/pending, otherwise parks the
// caller until the premium work clears.
export function waitWhilePremium() {
    if (!premiumBlocking()) return Promise.resolve();
    return new Promise((resolve) => freeGateWaiters.push(resolve));
}

function wakeFreeWaiters() {
    while (freeGateWaiters.length) freeGateWaiters.shift()();
}

// Bracket the actual scrape of a single free ISIN, so a waiting premium can
// tell when all in-flight free work has yielded.
export function beginFreeWork() {
    freeRunning++;
}

export function endFreeWork() {
    freeRunning = Math.max(0, freeRunning - 1);
    if (freeRunning === 0) {
        while (freeDrainWaiters.length) freeDrainWaiters.shift()();
    }
}

function waitForFreeDrain() {
    if (freeRunning === 0) return Promise.resolve();
    return new Promise((resolve) => freeDrainWaiters.push(resolve));
}

// Run `task` with exclusive premium priority. As soon as this is called, new
// free scrapes are blocked; we then wait for any in-flight free ISIN to finish,
// run the task alone, and finally release — resuming the next premium (if any)
// or the parked free requests.
export async function runExclusivePremium(task) {
    premiumPending++;

    // Serialize against other premium runs: take our place in the chain.
    const previous = premiumChainTail;
    let releaseChain;
    premiumChainTail = new Promise((r) => (releaseChain = r));
    await previous;

    premiumActive = true;
    premiumPending--;

    // Let any free ISIN currently mid-scrape finish, then we own the machine.
    await waitForFreeDrain();

    try {
        return await task();
    } finally {
        premiumActive = false;
        releaseChain();
        // Only release the free traffic when no premium remains queued/active.
        if (!premiumBlocking()) wakeFreeWaiters();
    }
}

// Inspection hook for tests.
export function _stats() {
    return {
        freeSlots,
        freeSlotQueue: freeSlotQueue.length,
        freeRunning,
        premiumActive,
        premiumPending,
        freeGateWaiters: freeGateWaiters.length,
    };
}
