const MAX_CONCURRENT = 2;
let active = 0;

export function tryAcquireSlot(): boolean {
    if (active >= MAX_CONCURRENT) return false;
    active += 1;
    return true;
}

export function releaseSlot(): void {
    if (active > 0) active -= 1;
}
