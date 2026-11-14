/**
 * Fair Judge Typed Event Bus
 * Lightweight, zero-dependency Pub/Sub architecture for decoupling UI components
 * from Supabase fetch cycles and asynchronous IndexedDB storage writes.
 */

export type EventBusCallback<T = any> = (data: T) => void;

export interface CacheUpdatedPayload {
  table: 'events' | 'participants' | 'judges' | 'scores' | 'organizations' | 'all' | string;
  data?: any;
}

export interface SyncStatusPayload {
  status: 'idle' | 'syncing' | 'synced' | 'offline';
  pendingCount?: number;
  message?: string;
}

export interface ToastPayload {
  id?: string;
  type: 'success' | 'warning' | 'info' | 'error';
  title: string;
  message?: string;
  duration?: number;
}

import type { OrgBlockCode } from './orgEnforcement';
import type { Organization } from './supabaseTypes';

export interface EventBusMap {
  cache_updated: CacheUpdatedPayload;
  sync_status: SyncStatusPayload;
  toast: ToastPayload;
  mutation_queued: { table: string; operation: string; entityId: string };
  trigger_pull_refresh: { force: boolean };
  org_enforcement: { code: OrgBlockCode; reason?: string };
  session_expired: { role: 'organiser' | 'judge'; reason: 'missing' | 'expired' };
}

class EventBus {
  private listeners: Map<string, Set<EventBusCallback>> = new Map();

  /**
   * Subscribe to a typed event
   * @returns Unsubscribe function
   */
  public on<K extends keyof EventBusMap>(
    event: K,
    callback: EventBusCallback<EventBusMap[K]>
  ): () => void;
  public on(event: string, callback: EventBusCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    return () => this.off(event as any, callback);
  }

  /**
   * Unsubscribe from an event
   */
  public off<K extends keyof EventBusMap>(
    event: K,
    callback: EventBusCallback<EventBusMap[K]>
  ): void;
  public off(event: string, callback: EventBusCallback): void {
    const subs = this.listeners.get(event);
    if (subs) {
      subs.delete(callback);
      if (subs.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  /**
   * Broadcast an event to all subscribers synchronously or next tick
   */
  public emit<K extends keyof EventBusMap>(event: K, data: EventBusMap[K]): void;
  public emit(event: string, data?: any): void {
    const subs = this.listeners.get(event);
    if (subs && subs.size > 0) {
      subs.forEach((cb) => {
        try {
          cb(data);
        } catch (err) {
          console.error(`Error in eventBus handler for "${event}":`, err);
        }
      });
    }
  }

  /**
   * Clear all listeners
   */
  public clear(): void {
    this.listeners.clear();
  }
}

export const eventBus = new EventBus();

export function areOrganizationsEqual(a: Organization, b: Organization): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.org_id === b.org_id &&
    a.name === b.name &&
    a.email === b.email &&
    a.verification_status === b.verification_status &&
    a.rejection_reason === b.rejection_reason &&
    a.suspended === b.suspended &&
    a.suspended_reason === b.suspended_reason &&
    a.deleted_at === b.deleted_at &&
    a.tie_breaker_enabled === b.tie_breaker_enabled &&
    a.tie_breaker_method === b.tie_breaker_method &&
    a.blind_judging_enabled === b.blind_judging_enabled &&
    a.auto_advance_enabled === b.auto_advance_enabled &&
    a.grace_period_enabled === b.grace_period_enabled &&
    a.isolated_jury_enabled === b.isolated_jury_enabled &&
    a.projector_blind_mode === b.projector_blind_mode &&
    a.projector_spotlight_mode === b.projector_spotlight_mode &&
    a.projector_ticker_text === b.projector_ticker_text &&
    a.projector_carousel_interval === b.projector_carousel_interval &&
    a.projector_confetti_at === b.projector_confetti_at &&
    JSON.stringify(a.custom_participant_fields || []) === JSON.stringify(b.custom_participant_fields || [])
  );
}

/**
 * Fast content-based equality check for arrays of records.
 * Compares primitive values directly and JSON-compares nested objects/arrays.
 * Returns true if both arrays have identical content.
 * Intentionally does NOT rely on updated_at since only events have it.
 */
export function areRecordsEqual<T extends Record<string, any>>(prev: T[], next: T[]): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.length !== next.length) return false;

  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (a === b) continue;
    if (!a || !b) return false;

    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
      const valA = a[key];
      const valB = b[key];
      if (valA === valB) continue;
      if (valA === null || valA === undefined || valB === null || valB === undefined) {
        return false;
      }
      if (typeof valA === 'object' && typeof valB === 'object') {
        if (JSON.stringify(valA) !== JSON.stringify(valB)) {
          return false;
        }
      } else {
        return false;
      }
    }
  }

  return true;
}
