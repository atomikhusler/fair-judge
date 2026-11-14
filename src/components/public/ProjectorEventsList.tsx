import React from 'react';
import { Calendar, Users, Gavel } from 'lucide-react';
import { SupabaseEvent } from '../../lib/supabaseTypes';

interface ProjectorEventsListProps {
  events: SupabaseEvent[];
  selectedEventId: string;
  onSelectEvent: (eventId: string) => void;
  isStadiumWhite: boolean;
}

function getStatusBadge(status: string) {
  const s = (status || 'draft').toLowerCase();
  if (s === 'active') {
    return {
      label: 'LIVE',
      dot: 'bg-emerald-500',
      badge: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
    };
  }
  if (s === 'paused') {
    return {
      label: 'PAUSED',
      dot: 'bg-amber-500',
      badge: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
    };
  }
  if (s === 'ended' || s === 'archived') {
    return {
      label: 'ENDED',
      dot: 'bg-zinc-400',
      badge: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30',
    };
  }
  if (s === 'ready' || s === 'upcoming') {
    return {
      label: s.toUpperCase(),
      dot: 'bg-sky-500',
      badge: 'bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30',
    };
  }
  return {
    label: 'DRAFT',
    dot: 'bg-orange-500',
    badge: 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30',
  };
}

export function ProjectorEventsList({
  events,
  selectedEventId,
  onSelectEvent,
  isStadiumWhite,
}: ProjectorEventsListProps) {
  return (
    <section aria-label="Events List" className="w-full flex flex-col flex-1 min-h-0">
      <div className="text-center space-y-1 mb-5">
        <div className="inline-flex items-center gap-2 font-mono text-[clamp(0.75rem,1vw,1.05rem)] uppercase font-bold tracking-widest text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-3.5 py-1 rounded-full border border-emerald-500/20">
          <span>COMPETITION SCHEDULE</span>
        </div>
        <h1
          className={`text-[clamp(1.5rem,3vw,3.4rem)] font-black tracking-tight leading-tight uppercase ${
            isStadiumWhite ? 'text-zinc-950' : 'text-white'
          }`}
        >
          Events Directory
        </h1>
        <p
          className={`text-[clamp(0.75rem,0.95vw,1.05rem)] font-mono ${
            isStadiumWhite ? 'text-zinc-600' : 'text-zinc-400'
          }`}
        >
          {events.length} {events.length === 1 ? 'Event' : 'Events'} Configured
        </p>
      </div>

      <div
        className={`rounded-2xl border overflow-hidden flex-1 flex flex-col min-h-0 ${
          isStadiumWhite
            ? 'bg-white border-stone-300 text-zinc-950 shadow-sm'
            : 'bg-zinc-950 border-zinc-800 text-white'
        }`}
      >
        <div className="overflow-y-auto max-h-[68vh] divide-y divide-stone-200 dark:divide-zinc-800/80">
          {events.length === 0 ? (
            <div className="p-12 text-center font-mono text-sm text-zinc-500">
              No events available.
            </div>
          ) : (
            events.map((evt) => {
              const st = getStatusBadge(evt.status);
              const isSelected = evt.id === selectedEventId;
              return (
                <button
                  key={evt.id}
                  type="button"
                  onClick={() => onSelectEvent(evt.id)}
                  className={`w-full min-h-[76px] px-5 py-4 text-left flex items-center justify-between gap-4 transition-opacity duration-150 motion-reduce:transition-none cursor-pointer ${
                    isSelected
                      ? isStadiumWhite
                        ? 'bg-emerald-50'
                        : 'bg-emerald-500/10'
                      : isStadiumWhite
                      ? 'hover:bg-stone-50'
                      : 'hover:bg-zinc-900/70'
                  }`}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[clamp(0.65rem,0.8vw,0.85rem)] font-mono font-black border ${st.badge}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                        {st.label}
                      </span>
                      <span
                        className={`text-[clamp(0.7rem,0.85vw,0.95rem)] font-mono uppercase font-bold ${
                          isStadiumWhite ? 'text-zinc-600' : 'text-zinc-400'
                        }`}
                      >
                        {evt.category || 'General'}
                      </span>
                    </div>
                    <div className="text-[clamp(1rem,1.45vw,1.6rem)] font-black tracking-tight truncate">
                      {evt.name}
                    </div>
                  </div>

                  <div className="flex items-center gap-5 shrink-0 font-mono text-[clamp(0.75rem,0.95vw,1.05rem)] tabular-nums">
                    {evt.date && (
                      <div
                        className={`hidden sm:flex items-center gap-1.5 ${
                          isStadiumWhite ? 'text-zinc-600' : 'text-zinc-400'
                        }`}
                      >
                        <Calendar className="w-4 h-4" />
                        <span>{evt.date}</span>
                      </div>
                    )}
                    <div
                      className={`flex items-center gap-1.5 font-bold ${
                        isStadiumWhite ? 'text-zinc-800' : 'text-zinc-200'
                      }`}
                    >
                      <Users className="w-4 h-4 text-emerald-500" />
                      <span>{evt.assigned_participants?.length || 0}</span>
                    </div>
                    <div
                      className={`flex items-center gap-1.5 font-bold ${
                        isStadiumWhite ? 'text-zinc-800' : 'text-zinc-200'
                      }`}
                    >
                      <Gavel className="w-4 h-4 text-amber-500" />
                      <span>{evt.assigned_judges?.length || 0}</span>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
