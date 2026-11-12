/**
 * Storage Persistence Utility
 * Epic 15.7 Step A2: Requests browser storage persistence after successful login
 * once per app session without UI or toasts.
 */

let hasRequestedStoragePersistThisSession = false;

export async function requestStoragePersistenceOnce(): Promise<void> {
  if (hasRequestedStoragePersistThisSession) return;
  hasRequestedStoragePersistThisSession = true;

  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.persist === 'function'
    ) {
      const isPersisted =
        typeof navigator.storage.persisted === 'function'
          ? await navigator.storage.persisted()
          : false;

      if (!isPersisted) {
        await navigator.storage.persist();
      }
    }
  } catch {
    // Silent catch as mandated: no UI, no toast
  }
}
