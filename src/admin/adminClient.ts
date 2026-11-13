import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseCredentials, isSupabaseConfigured } from '../lib/supabase';
import { ADMIN_AUTH_STORAGE_KEY, safeAdminStorage } from './adminSession';

let adminClientInstance: SupabaseClient | null = null;
let cachedCredKey = '';

export function getAdminClient(): SupabaseClient {
  const { url, anonKey } = getSupabaseCredentials();
  const key = `${url}|${anonKey}`;

  if (!adminClientInstance || cachedCredKey !== key) {
    cachedCredKey = key;
    const validUrl = isSupabaseConfigured() ? url : 'https://placeholder.supabase.co';
    const validKey = anonKey || 'placeholder-anon-key';

    adminClientInstance = createClient(validUrl, validKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: ADMIN_AUTH_STORAGE_KEY,
        storage: safeAdminStorage,
      },
    });
  }

  return adminClientInstance;
}

export function resetAdminClient(): void {
  adminClientInstance = null;
  cachedCredKey = '';
}
