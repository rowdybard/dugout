import type {Profile} from '../market/types';

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Network completion order is not account mutation order. */
export function shouldAcceptProfile(current: Profile | null, candidate: Profile): boolean {
  if (candidate.revision !== undefined && !validRevision(candidate.revision)) return false;
  if (!current) return true;
  if (!validRevision(current.revision)) return true;
  // Once a versioned snapshot is known, neither legacy nor equal/older reads
  // can replace it. Equal revisions also preserve stable React state identity.
  return validRevision(candidate.revision) && candidate.revision > current.revision;
}
