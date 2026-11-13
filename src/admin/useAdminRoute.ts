import { useState, useEffect, useCallback, useRef } from 'react';

export type AdminRootTab = 'overview' | 'orgs' | 'inbox' | 'more';
export type AdminMoreSection = 'notices' | 'alerts' | 'activity';
export type AdminNavDirection = 'tab' | 'forward' | 'back';

export interface AdminRouteState {
  tab: AdminRootTab;
  orgId: string | null;
  reportId: string | null;
  moreSection: AdminMoreSection | null;
  rawHash: string;
}

export function parseAdminHash(hash: string): AdminRouteState {
  const clean = (hash || '').split('?')[0].replace(/\/+$/, '');
  if (!clean || clean === '#/admin' || clean === '#admin') {
    return { tab: 'overview', orgId: null, reportId: null, moreSection: null, rawHash: '#/admin' };
  }

  const withoutPrefix = clean.replace(/^#\/?admin\/?/, '');
  if (!withoutPrefix) {
    return { tab: 'overview', orgId: null, reportId: null, moreSection: null, rawHash: '#/admin' };
  }

  const parts = withoutPrefix.split('/').filter(Boolean);
  const section = parts[0]?.toLowerCase();

  if (section === 'orgs') {
    const orgId = parts[1] ? decodeURIComponent(parts[1]) : null;
    return {
      tab: 'orgs',
      orgId,
      reportId: null,
      moreSection: null,
      rawHash: orgId ? `#/admin/orgs/${encodeURIComponent(orgId)}` : '#/admin/orgs',
    };
  }

  if (section === 'inbox') {
    const reportId = parts[1] ? decodeURIComponent(parts[1]) : null;
    return {
      tab: 'inbox',
      orgId: null,
      reportId,
      moreSection: null,
      rawHash: reportId ? `#/admin/inbox/${encodeURIComponent(reportId)}` : '#/admin/inbox',
    };
  }

  if (section === 'more') {
    const sub = parts[1]?.toLowerCase();
    const moreSection: AdminMoreSection | null =
      sub === 'notices' || sub === 'alerts' || sub === 'activity' ? sub : null;
    return {
      tab: 'more',
      orgId: null,
      reportId: null,
      moreSection,
      rawHash: moreSection ? `#/admin/more/${moreSection}` : '#/admin/more',
    };
  }

  // Unknown route -> Overview
  return { tab: 'overview', orgId: null, reportId: null, moreSection: null, rawHash: '#/admin' };
}

export function isDrillDownRoute(route: AdminRouteState): boolean {
  return Boolean(route.orgId || route.reportId || route.moreSection);
}

export function getParentHash(route: AdminRouteState): string {
  if (route.orgId) return '#/admin/orgs';
  if (route.reportId) return '#/admin/inbox';
  if (route.moreSection) return '#/admin/more';
  return '#/admin';
}

export function tabToHash(tab: AdminRootTab): string {
  if (tab === 'overview') return '#/admin';
  return `#/admin/${tab}`;
}

export function useAdminRoute() {
  const [route, setRoute] = useState<AdminRouteState>(() =>
    parseAdminHash(typeof window !== 'undefined' ? window.location.hash : '#/admin')
  );
  const [direction, setDirection] = useState<AdminNavDirection>('tab');
  const pushDepthRef = useRef(0);

  useEffect(() => {
    const handleHashChange = () => {
      const next = parseAdminHash(window.location.hash);
      setRoute((prev) => {
        const prevDepth = isDrillDownRoute(prev) ? 1 : 0;
        const nextDepth = isDrillDownRoute(next) ? 1 : 0;
        if (nextDepth > prevDepth) {
          setDirection('forward');
        } else if (nextDepth < prevDepth) {
          pushDepthRef.current = Math.max(0, pushDepthRef.current - 1);
          setDirection('back');
        } else {
          setDirection('tab');
        }
        return next;
      });
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, []);

  const replaceHash = useCallback((hash: string, navDir: AdminNavDirection = 'tab') => {
    const normalized = parseAdminHash(hash);
    if (typeof window !== 'undefined') {
      const base = window.location.pathname + window.location.search;
      if (window.location.hash !== normalized.rawHash) {
        history.replaceState(null, '', base + normalized.rawHash);
      }
    }
    setDirection(navDir);
    setRoute(normalized);
  }, []);

  const switchTab = useCallback(
    (tab: AdminRootTab) => {
      pushDepthRef.current = 0;
      replaceHash(tabToHash(tab), 'tab');
    },
    [replaceHash]
  );

  const pushRoute = useCallback((hash: string) => {
    const normalized = parseAdminHash(hash);
    setDirection('forward');
    if (typeof window !== 'undefined') {
      if (window.location.hash !== normalized.rawHash) {
        pushDepthRef.current += 1;
        window.location.hash = normalized.rawHash;
        return;
      }
    }
    setRoute(normalized);
  }, []);

  const goUp = useCallback(() => {
    if (!isDrillDownRoute(route)) return;
    if (pushDepthRef.current > 0 && typeof window !== 'undefined') {
      pushDepthRef.current = Math.max(0, pushDepthRef.current - 1);
      window.history.back();
      return;
    }
    replaceHash(getParentHash(route), 'back');
  }, [route, replaceHash]);

  return {
    route,
    direction,
    isDrillDown: isDrillDownRoute(route),
    switchTab,
    pushRoute,
    replaceRoute: replaceHash,
    goUp,
  };
}
