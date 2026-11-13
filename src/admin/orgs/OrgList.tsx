import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Search, X, Building2, AlertTriangle, Trash2 } from 'lucide-react';
import { adminService, AdminOrg } from '../adminService';
import { EmptyState, GroupedList, ListRow, Segmented, Skel } from '../ui';
import { triggerHaptic } from '../../lib/haptics';
import { OrgRow } from './OrgRow';
import { OrgUiFilter, mapUiFilterToRpc } from './orgUtils';

interface OrgListProps {
  initialFilter: OrgUiFilter;
  filterSyncNonce: number;
  selectedOrgId: string | null;
  highlightedOrgId: string | null;
  refreshNonce: number;
  isOnline: boolean;
  onSelectOrg: (org: AdminOrg) => void;
  onOrgsLoaded?: (orgs: AdminOrg[]) => void;
}

const PAGE_SIZE = 20;

const FILTER_OPTIONS: Array<{ value: OrgUiFilter; label: string }> = [
  { value: 'pending', label: 'Pending' },
  { value: 'active', label: 'Active' },
  { value: 'bin', label: 'Bin' },
];

export function OrgList({
  initialFilter,
  filterSyncNonce,
  selectedOrgId,
  highlightedOrgId,
  refreshNonce,
  isOnline,
  onSelectOrg,
  onOrgsLoaded,
}: OrgListProps) {
  const [filter, setFilter] = useState<OrgUiFilter>(initialFilter);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [orgs, setOrgs] = useState<AdminOrg[]>([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // List entrance animation ONLY on first render of this screen (not on refresh or filter change)
  const [allowEntranceAnim, setAllowEntranceAnim] = useState(true);
  const entranceUsedRef = useRef(false);

  useEffect(() => {
    setFilter(initialFilter);
  }, [initialFilter, filterSyncNonce]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filter, debouncedSearch]);

  const loadOrgs = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const rpcFilter = mapUiFilterToRpc(filter);
      const list = await adminService.listOrgs(rpcFilter, debouncedSearch);
      const normalized = Array.isArray(list) ? list : [];
      setOrgs(normalized);
      onOrgsLoaded?.(normalized);
    } catch (err: any) {
      setError(err?.message || 'Failed to load organisers.');
    } finally {
      setIsLoading(false);
    }
  }, [filter, debouncedSearch, onOrgsLoaded]);

  useEffect(() => {
    void loadOrgs();
  }, [loadOrgs, refreshNonce]);

  useEffect(() => {
    if (!isLoading && orgs.length > 0 && !entranceUsedRef.current) {
      entranceUsedRef.current = true;
      const t = window.setTimeout(() => setAllowEntranceAnim(false), 450);
      return () => window.clearTimeout(t);
    }
  }, [isLoading, orgs.length]);

  const handleFilterChange = (next: OrgUiFilter) => {
    entranceUsedRef.current = true;
    setAllowEntranceAnim(false);
    setFilter(next);
  };

  const pagedOrgs = orgs.slice(0, visibleCount);
  const remaining = Math.max(0, orgs.length - pagedOrgs.length);

  return (
    <div className="space-y-4">
      {/* Sticky search + segmented filter */}
      <div className="sticky top-[48px] md:top-0 z-10 bg-zinc-50 dark:bg-zinc-950 pt-1 pb-2 space-y-2.5">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
          />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => {
              entranceUsedRef.current = true;
              setAllowEntranceAnim(false);
              setSearchInput(e.target.value);
            }}
            placeholder="Search name, ID, or email"
            aria-label="Search organisers"
            className="w-full min-h-[44px] pl-10 pr-11 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-[15px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500/60"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput('')}
              aria-label="Clear search"
              className="absolute right-0 top-0 bottom-0 min-w-[44px] min-h-[44px] flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 rounded-xl cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <Segmented
          options={FILTER_OPTIONS}
          value={filter}
          onChange={handleFilterChange}
          ariaLabel="Organiser status filter"
        />
      </div>

      {/* Error State */}
      {error && (
        <EmptyState
          icon={<AlertTriangle className="w-5 h-5 text-red-500" />}
          message={error}
          actionLabel="Retry"
          onAction={() => void loadOrgs()}
          actionDisabled={!isOnline}
        />
      )}

      {/* Loading Skeleton */}
      {isLoading && orgs.length === 0 && !error && (
        <GroupedList>
          {Array.from({ length: 5 }).map((_, i) => (
            <ListRow
              key={i}
              leading={<Skel w={40} h={40} rounded="rounded-full" />}
              title={<Skel w="62%" h={15} />}
              subtitle={<Skel w="42%" h={12} />}
              trailing={<Skel w={64} h={22} rounded="rounded-full" />}
            />
          ))}
        </GroupedList>
      )}

      {/* Empty State */}
      {!isLoading && !error && orgs.length === 0 && (
        <EmptyState
          icon={
            filter === 'bin' ? (
              <Trash2 className="w-5 h-5" />
            ) : (
              <Building2 className="w-5 h-5" />
            )
          }
          message={
            debouncedSearch
              ? `No organisers matching "${debouncedSearch}".`
              : filter === 'pending'
                ? 'No pending organiser requests.'
                : filter === 'bin'
                  ? 'The bin is empty.'
                  : 'No active organisers found.'
          }
          actionLabel={debouncedSearch ? 'Clear search' : undefined}
          onAction={debouncedSearch ? () => setSearchInput('') : undefined}
        />
      )}

      {/* Grouped Organiser Rows */}
      {!error && pagedOrgs.length > 0 && (
        <div className="space-y-3">
          <GroupedList>
            {pagedOrgs.map((org, index) => (
              <OrgRow
                key={org.org_id}
                org={org}
                isSelected={selectedOrgId === org.org_id}
                isHighlighted={highlightedOrgId === org.org_id}
                animateIndex={allowEntranceAnim && index < 8 ? index : undefined}
                onSelect={onSelectOrg}
              />
            ))}
          </GroupedList>

          {remaining > 0 && (
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                entranceUsedRef.current = true;
                setAllowEntranceAnim(false);
                setVisibleCount((c) => c + PAGE_SIZE);
              }}
              className="admin-press w-full min-h-[44px] rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 text-[14px] font-semibold text-zinc-900 dark:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
            >
              Load more ({remaining} remaining)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
