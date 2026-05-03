/** Late-bound bridge between /personality and PersonalityRegistry. */

export interface PersonalityEntry {
    readonly name: string;
    readonly description: string;
}

export interface PersonalityFacade {
    list(): ReadonlyArray<PersonalityEntry>;
    getActive(rawKey: string): string | null;
    /** Pass null to clear. Returns false when no active session, unknown name, or no-op. */
    setActive(rawKey: string, name: string | null): boolean;
    /** Evict cached ThreadEntry so next invoke rebuilds with the new overlay. */
    evictThread(rawKey: string): void;
}

let facade: PersonalityFacade | null = null;

export function setPersonalityFacade(f: PersonalityFacade | null): void {
    facade = f;
}

export function getPersonalityFacade(): PersonalityFacade | null {
    return facade;
}
