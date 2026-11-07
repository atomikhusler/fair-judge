import React, { useState, useRef, ReactNode, TouchEvent } from 'react';
import { RefreshCw } from 'lucide-react';

interface PullToRefreshProps {
  onRefresh: () => Promise<void> | void;
  children: ReactNode;
  className?: string;
  pullThreshold?: number;
  accentColor?: string;
}

export function PullToRefresh({
  onRefresh,
  children,
  className = '',
  pullThreshold = 70,
}: PullToRefreshProps) {
  const [pullY, setPullY] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const startYRef = useRef(0);
  const isPullingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    if (isRefreshing) return;
    const el = containerRef.current;
    if (el && el.scrollTop <= 0) {
      startYRef.current = e.touches[0].clientY;
      isPullingRef.current = true;
    }
  };

  const handleTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    if (!isPullingRef.current || isRefreshing) return;
    const currentY = e.touches[0].clientY;
    const diff = currentY - startYRef.current;
    if (diff > 0) {
      // Apply rubber-band damping resistance
      const damped = Math.min(diff * 0.45, pullThreshold * 1.5);
      setPullY(damped);
    } else {
      setPullY(0);
    }
  };

  const handleTouchEnd = async () => {
    if (!isPullingRef.current) return;
    isPullingRef.current = false;

    if (pullY >= pullThreshold && !isRefreshing) {
      setIsRefreshing(true);
      setPullY(45);
      try {
        await onRefresh();
      } catch (err) {
        console.warn('Pull-to-refresh execution note:', err);
      } finally {
        setTimeout(() => {
          setIsRefreshing(false);
          setPullY(0);
        }, 300);
      }
    } else {
      setPullY(0);
    }
  };

  return (
    <div
      ref={containerRef}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      className={`relative overflow-y-auto ${className}`}
    >
      {/* Pull Indicator */}
      <div
        style={{
          transform: `translate3d(0, ${pullY - 45}px, 0)`,
          opacity: pullY > 10 ? Math.min(pullY / 45, 1) : 0,
          transition: isPullingRef.current ? 'none' : 'transform 200ms ease-out, opacity 200ms ease-out',
        }}
        className="absolute top-0 left-0 right-0 h-10 flex items-center justify-center pointer-events-none z-40"
      >
        <div className="w-8 h-8 rounded-full bg-zinc-900 border border-zinc-700 shadow-md flex items-center justify-center text-amber-400">
          <RefreshCw
            className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}
            style={{
              transform: isRefreshing ? undefined : `rotate(${pullY * 3}deg)`,
            }}
          />
        </div>
      </div>

      {/* Content wrapper with translateY */}
      <div
        style={{
          transform: `translate3d(0, ${pullY}px, 0)`,
          transition: isPullingRef.current ? 'none' : 'transform 200ms cubic-bezier(0.32, 0.72, 0, 1)',
        }}
        className="w-full h-full"
      >
        {children}
      </div>
    </div>
  );
}
