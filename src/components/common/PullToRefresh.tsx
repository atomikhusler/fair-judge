import React, { useState, useRef, useEffect, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';

interface PullToRefreshProps {
  onRefresh: () => Promise<void> | void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}

export function PullToRefresh({
  onRefresh,
  children,
  className = '',
  disabled = false,
}: PullToRefreshProps) {
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const isDraggingRef = useRef(false);

  const threshold = 65;
  const maxPull = 90;

  // Handle Touch Start
  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (disabled || isRefreshing) return;

    const container = containerRef.current;
    // Only engage if container is scrolled to the absolute top
    const isAtTop = !container || container.scrollTop <= 0;

    if (isAtTop) {
      startYRef.current = e.touches[0].clientY;
      isDraggingRef.current = true;
      setIsPulling(false);
    }
  };

  // Handle Touch Move with Rubber-band Resistance
  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current || isRefreshing || disabled) return;

    const container = containerRef.current;
    if (container && container.scrollTop > 0) {
      // User has scrolled down, cancel PTR
      isDraggingRef.current = false;
      setIsPulling(false);
      setPullDistance(0);
      return;
    }

    const currentY = e.touches[0].clientY;
    const rawDeltaY = currentY - startYRef.current;

    if (rawDeltaY > 0) {
      // Pull down to refresh gesture
      setIsPulling(true);
      const calculatedPull = Math.min(rawDeltaY * 0.45, maxPull);
      setPullDistance(calculatedPull);
    } else {
      // User is scrolling down the list, release drag immediately
      isDraggingRef.current = false;
      setIsPulling(false);
      setPullDistance(0);
    }
  };

  // Handle Touch End / Release
  const handleTouchEnd = async () => {
    if (!isDraggingRef.current || isRefreshing || disabled) {
      isDraggingRef.current = false;
      setIsPulling(false);
      return;
    }

    isDraggingRef.current = false;
    setIsPulling(false);

    if (pullDistance >= threshold) {
      // Trigger Refresh Action
      setIsRefreshing(true);
      setPullDistance(52); // Keep indicator visible during refresh

      try {
        await Promise.resolve(onRefresh());
      } catch (err) {
        console.error('PullToRefresh sync failed:', err);
      } finally {
        // Smoothly spring back to translateY(0)
        setTimeout(() => {
          setIsRefreshing(false);
          setPullDistance(0);
        }, 300);
      }
    } else {
      // Snap back if threshold wasn't reached
      setPullDistance(0);
    }
  };

  return (
    <div
      ref={containerRef}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      className={`relative min-h-[100dvh] w-full overflow-y-auto overscroll-y-contain ${className}`}
    >
      {/* Visual Indicator: Pinned at top-center, translates smoothly */}
      <div
        className={`absolute left-1/2 -translate-x-1/2 z-50 pointer-events-none flex items-center justify-center transition-all ${
          isPulling ? 'duration-75' : 'duration-300 ease-out'
        }`}
        style={{
          top: 8,
          transform: `translate3d(-50%, ${pullDistance}px, 0)`,
          opacity: pullDistance > 8 || isRefreshing ? 1 : 0,
          scale: pullDistance > 8 || isRefreshing ? Math.min(pullDistance / 40, 1) : 0.5,
        }}
        aria-hidden="true"
      >
        <div className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 shadow-md rounded-full p-2 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
          <RefreshCw
            className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}
            style={{
              transform: !isRefreshing ? `rotate(${pullDistance * 4}deg)` : undefined,
              transition: isPulling ? 'none' : 'transform 0.2s',
            }}
          />
        </div>
      </div>

      {/* Content */}
      {children}
    </div>
  );
}
