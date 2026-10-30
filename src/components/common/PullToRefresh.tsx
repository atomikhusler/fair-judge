import React, { useState, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { flushOfflineQueueToSupabase } from '../../lib/offlineQueue';

interface PullToRefreshProps {
  onRefresh?: () => Promise<void> | void;
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
  const startXRef = useRef(0);
  const isDraggingRef = useRef(false);

  const threshold = 64;
  const maxPull = 92;

  // Checks if touch started inside a form control or a horizontally scrolled container
  const shouldIgnoreTouch = (target: EventTarget | null): boolean => {
    const root = containerRef.current;
    if (!root || root.scrollTop > 0) return true;

    if (target instanceof Element) {
      // Ignore if user is touching an input field or button
      if (target.closest('input, textarea, select, button')) return true;
      
      // Ignore if user is touching inside a horizontally scrollable element (like the Stats table)
      let el: Element | null = target;
      while (el && el !== root) {
        if (el.scrollWidth > el.clientWidth && el.scrollLeft > 0) return true;
        el = el.parentElement;
      }
    }
    return false;
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (disabled || isRefreshing || e.touches.length !== 1) return;

    if (!shouldIgnoreTouch(e.target)) {
      startYRef.current = e.touches[0].clientY;
      startXRef.current = e.touches[0].clientX;
      isDraggingRef.current = true;
      setIsPulling(false);
    } else {
      isDraggingRef.current = false;
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current || isRefreshing || disabled) return;

    const currentY = e.touches[0].clientY;
    const currentX = e.touches[0].clientX;
    const deltaY = currentY - startYRef.current;
    const deltaX = Math.abs(currentX - startXRef.current);

    // Cancel pull if the user is swiping horizontally more than vertically
    if (deltaX > Math.abs(deltaY) && deltaX > 10) {
      isDraggingRef.current = false;
      setIsPulling(false);
      setPullDistance(0);
      return;
    }

    if (deltaY > 8 && containerRef.current?.scrollTop === 0) {
      setIsPulling(true);
      const damped = Math.min((deltaY - 8) * 0.45, maxPull);
      setPullDistance(damped);
      
      // Prevent native scroll chaining while pulling
      if (e.cancelable) e.preventDefault();
    } else if (deltaY < 0) {
      isDraggingRef.current = false;
      setIsPulling(false);
      setPullDistance(0);
    }
  };

  const handleTouchEnd = async () => {
    if (!isDraggingRef.current || isRefreshing || disabled) {
      isDraggingRef.current = false;
      setIsPulling(false);
      return;
    }

    isDraggingRef.current = false;
    setIsPulling(false);

    if (pullDistance >= threshold) {
      setIsRefreshing(true);
      setPullDistance(48); // Lock spinner at this height during refresh

      try {
        // 1. Flush any offline queued scores to Supabase first
        await flushOfflineQueueToSupabase();
        
        // 2. Run custom cloud refresh handler (this handles UI state updates)
        if (onRefresh) {
          await Promise.resolve(onRefresh());
        }
      } catch (err) {
        console.error('PullToRefresh sync failed:', err);
      } finally {
        setTimeout(() => {
          setIsRefreshing(false);
          setPullDistance(0);
        }, 320);
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
      className={`relative w-full overscroll-y-contain ${className}`}
    >
      {/* Floating Refresh Spinner */}
      <div
        className={`absolute left-1/2 -translate-x-1/2 z-50 pointer-events-none flex items-center justify-center transition-all ${
          isPulling ? 'duration-75' : 'duration-300 ease-out'
        }`}
        style={{
          top: 8,
          transform: `translate3d(-50%, ${pullDistance}px, 0)`,
          opacity: pullDistance > 10 || isRefreshing ? 1 : 0,
          scale: pullDistance > 10 || isRefreshing ? Math.min(pullDistance / 42, 1) : 0.5,
        }}
        aria-hidden="true"
      >
        <div className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 shadow-lg rounded-full p-2.5 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
          <RefreshCw
            className={`w-4 h-4 stroke-[2.4] ${isRefreshing ? 'animate-spin' : ''}`}
            style={{
              transform: !isRefreshing ? `rotate(${pullDistance * 4.5}deg)` : undefined,
              transition: isPulling ? 'none' : 'transform 0.2s',
            }}
          />
        </div>
      </div>

      {children}
    </div>
  );
}
