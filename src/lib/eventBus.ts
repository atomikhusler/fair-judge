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

export interface EventBusMap {
  cache_updated: CacheUpdatedPayload;
  sync_status: SyncStatusPayload;
  toast: ToastPayload;
  mutation_queued: { table: string; operation: string; entityId: string };
  trigger_pull_refresh: { force: boolean };
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
