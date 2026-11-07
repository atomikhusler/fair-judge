import React, { useState, useEffect } from 'react';
import { 
  CalendarDays, 
  Plus, 
  Play, 
  Pause, 
  CheckCircle, 
  Trash2, 
  Copy, 
  Edit3, 
  Users, 
  Scale, 
  X, 
  Check, 
  ChevronRight,
  Sparkles
} from 'lucide-react';
import { Organization, SupabaseEvent, SupabaseParticipant, SupabaseJudge, RubricCriterion, EventStatus } from '../../../lib/supabaseTypes';
import { dbService, subscribeToDatabase } from '../../../lib/supabase';
import { useToast } from '../../common/ToastProvider';

interface EventsTabProps {
  organization: Organization;
  onOpenPublicView?: (eventId?: string) => void;
  onNavigateToLiveControl?: () => void;
}

export function EventsTab({ organization }: EventsTabProps) {
  const { showToast } = useToast();
  const [events, setEvents] = useState<SupabaseEvent[]>([]);
  const [participants, setParticipants] = useState<SupabaseParticipant[]>([]);
  const [judges, setJudges] = useState<SupabaseJudge[]>([]);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<SupabaseEvent | null>(null);

  // Form states
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [rubric, setRubric] = useState<RubricCriterion[]>([
    { id: 'crit_1', name: 'Presentation & Delivery', max_marks: 30, weight: 1 },
    { id: 'crit_2', name: 'Technical Execution', max_marks: 40, weight: 1 },
    { id: 'crit_3', name: 'Originality & Creativity', max_marks: 30, weight: 1 },
  ]);

  const loadData = async () => {
    try {
      const [evts, partList, judgeList] = await Promise.all([
        dbService.getEvents(organization.org_id),
        dbService.getParticipants(organization.org_id),
        dbService.getJudges(organization.org_id),
      ]);
      setEvents(evts);
      setParticipants(partList);
      setJudges(judgeList);
    } catch (err) {
      console.warn('Events data fetch note:', err);
    }
  };

  useEffect(() => {
    loadData();
    const unsub = subscribeToDatabase((table) => {
      if (table === 'events' || table === 'all') {
        loadData();
      }
    });
    return () => unsub();
  }, [organization.org_id]);

  const handleOpenCreate = () => {
    setName('');
    setCategory('');
    setRubric([
      { id: `crit_${Date.now()}_1`, name: 'Execution & Poise', max_marks: 30, weight: 1 },
      { id: `crit_${Date.now()}_2`, name: 'Technical Precision', max_marks: 40, weight: 1 },
      { id: `crit_${Date.now()}_3`, name: 'Overall Impression', max_marks: 30, weight: 1 },
    ]);
    setEditingEvent(null);
    setIsCreateModalOpen(true);
  };

  const handleOpenEdit = (evt: SupabaseEvent) => {
    setEditingEvent(evt);
    setName(evt.name);
    setCategory(evt.category || '');
    setRubric(evt.rubric_schema || evt.rubric || []);
    setIsCreateModalOpen(true);
  };

  const handleSaveEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      showToast('Please provide an Event Title.', 'warning');
      return;
    }
    if (rubric.length === 0) {
      showToast('Please add at least one valid rubric criterion.', 'warning');
      return;
    }

    try {
      if (editingEvent) {
        await dbService.updateEvent(editingEvent.id, {
          name: cleanName,
          category: category.trim() || undefined,
          rubric_schema: rubric,
        });
        showToast(`Event "${cleanName}" updated.`);
      } else {
        await dbService.createEvent({
          org_id: organization.org_id,
          name: cleanName,
          category: category.trim() || 'General',
          status: 'draft',
          rubric_schema: rubric,
          assigned_participants: participants.map((p) => p.id),
          assigned_judges: judges.map((j) => j.id),
        });
        showToast(`Event "${cleanName}" created as draft.`);
      }
      setIsCreateModalOpen(false);
      loadData();
    } catch (err: any) {
      showToast(err?.message || 'Error saving event. Please check inputs.', 'error');
    }
  };

  const handleToggleStatus = async (evt: SupabaseEvent, nextStatus: EventStatus) => {
    try {
      await dbService.updateEvent(evt.id, { status: nextStatus });
      showToast(`Event marked as ${nextStatus.toUpperCase()}.`);
      loadData();
    } catch {
      showToast('Status update deferred.');
    }
  };

  const handleDelete = async (evt: SupabaseEvent) => {
    if (evt.status === 'active') {
      showToast('Action Denied: Cannot delete an active event. Pause or End it first.', 'warning');
      return;
    }
    if (!confirm(`Are you sure you want to permanently delete "${evt.name}"?`)) return;

    try {
      await dbService.deleteEvent(evt.id);
      showToast(`Event "${evt.name}" was permanently deleted.`);
      loadData();
    } catch {
      showToast('Action failed.', 'error');
    }
  };

  const handleDuplicate = async (evt: SupabaseEvent) => {
    try {
      await dbService.createEvent({
        org_id: organization.org_id,
        name: `${evt.name} (Copy)`,
        category: evt.category,
        status: 'draft',
        rubric_schema: evt.rubric_schema || evt.rubric,
        assigned_participants: evt.assigned_participants || [],
        assigned_judges: evt.assigned_judges,
      });
      showToast(`Duplicated "${evt.name}" as draft.`);
      loadData();
    } catch {
      showToast('Duplication failed.', 'error');
    }
  };

  return (
    <div className="w-full space-y-6">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-3xl bg-zinc-900/80 border border-zinc-800 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center">
            <CalendarDays className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-base font-black text-white">Event Architecture & Rubrics</h2>
            <p className="text-xs text-zinc-400">Manage competition divisions, scoring rules & rosters</p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleOpenCreate}
          className="h-10 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-extrabold text-xs flex items-center gap-1.5 active:scale-95 cursor-pointer shadow-md self-start sm:self-auto"
        >
          <Plus className="w-4 h-4 stroke-[2.5]" />
          <span>New Competition Event</span>
        </button>
      </div>

      {/* Events Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {events.length === 0 ? (
          <div className="col-span-full p-12 rounded-3xl bg-zinc-900/40 border border-zinc-800 text-center">
            <CalendarDays className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
            <p className="text-sm font-bold text-zinc-400">No competition events configured</p>
            <p className="text-xs text-zinc-500 mt-1">
              Click &quot;New Competition Event&quot; above to build your first rubric and division.
            </p>
          </div>
        ) : (
          events.map((evt) => {
            const isActive = evt.status === 'active';
            const isPaused = evt.status === 'paused';
            const isConcluded = evt.status === 'ended';

            return (
              <div
                key={evt.id}
                className="p-5 rounded-3xl bg-zinc-900/70 border border-zinc-800 flex flex-col justify-between gap-4 shadow-md hover:border-zinc-700 transition-all"
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase ${
                        isActive
                          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                          : isPaused
                          ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                          : isConcluded
                          ? 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                          : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {evt.status}
                    </span>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleDuplicate(evt)}
                        title="Duplicate Event"
                        className="w-8 h-8 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center cursor-pointer"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOpenEdit(evt)}
                        title="Edit Rubric & Name"
                        className="w-8 h-8 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center cursor-pointer"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(evt)}
                        title="Delete Event"
                        className="w-8 h-8 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-400 hover:text-rose-400 flex items-center justify-center cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <h3 className="text-lg font-black text-white">{evt.name}</h3>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Category: {evt.category || 'General'}
                  </p>

                  <div className="mt-4 flex items-center gap-4 text-xs font-mono text-zinc-400">
                    <span className="flex items-center gap-1.5">
                      <Users className="w-3.5 h-3.5 text-blue-400" />
                      <span>{evt.assigned_participants?.length || 0} Competitors</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Scale className="w-3.5 h-3.5 text-amber-400" />
                      <span>{evt.assigned_judges?.length || 0} Judges</span>
                    </span>
                  </div>
                </div>

                {/* Status action buttons */}
                <div className="pt-4 border-t border-zinc-800/80 flex items-center justify-between gap-2">
                  {isActive ? (
                    <button
                      type="button"
                      onClick={() => handleToggleStatus(evt, 'paused')}
                      className="flex-1 py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Pause className="w-3.5 h-3.5" />
                      <span>Pause Scoring</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleToggleStatus(evt, 'active')}
                      className="flex-1 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Activate Event</span>
                    </button>
                  )}

                  {!isConcluded && (
                    <button
                      type="button"
                      onClick={() => handleToggleStatus(evt, 'ended')}
                      className="px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-750 text-zinc-300 text-xs font-bold flex items-center justify-center gap-1 cursor-pointer"
                    >
                      <CheckCircle className="w-3.5 h-3.5" />
                      <span>Conclude</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Create / Edit Event Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 overflow-y-auto">
          <div className="w-full max-w-lg rounded-3xl bg-zinc-950 border border-zinc-800 p-6 sm:p-8 shadow-2xl my-8">
            <div className="flex items-center justify-between pb-4 border-b border-zinc-800 mb-5">
              <h3 className="text-lg font-black text-white">
                {editingEvent ? 'Edit Event Details' : 'Create New Competition Event'}
              </h3>
              <button
                type="button"
                onClick={() => setIsCreateModalOpen(false)}
                className="w-8 h-8 rounded-full bg-zinc-900 text-zinc-400 hover:text-white flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveEvent} className="space-y-4">
              <div>
                <label className="block text-[11px] font-mono font-bold text-zinc-400 uppercase tracking-wider mb-1">
                  Event Title
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Solo Dance - Senior Finals"
                  className="w-full h-11 px-3.5 rounded-xl bg-zinc-900 border border-zinc-800 text-white text-sm"
                />
              </div>

              <div>
                <label className="block text-[11px] font-mono font-bold text-zinc-400 uppercase tracking-wider mb-1">
                  Category or Division
                </label>
                <input
                  type="text"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="e.g. Performing Arts, Coding, Debate"
                  className="w-full h-11 px-3.5 rounded-xl bg-zinc-900 border border-zinc-800 text-white text-sm"
                />
              </div>

              {/* Rubric Criteria Builder */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[11px] font-mono font-bold text-zinc-400 uppercase tracking-wider">
                    Rubric Criteria ({rubric.length})
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setRubric([
                        ...rubric,
                        { id: `crit_${Date.now()}`, name: 'New Criterion', max_marks: 25, weight: 1 },
                      ])
                    }
                    className="text-xs font-bold text-emerald-400 hover:text-emerald-300 flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Criterion</span>
                  </button>
                </div>

                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                  {rubric.map((crit, idx) => (
                    <div
                      key={crit.id}
                      className="flex items-center gap-2 p-2.5 rounded-xl bg-zinc-900 border border-zinc-800"
                    >
                      <input
                        type="text"
                        value={crit.name}
                        onChange={(e) => {
                          const updated = [...rubric];
                          updated[idx].name = e.target.value;
                          setRubric(updated);
                        }}
                        placeholder="Criterion title"
                        className="flex-1 h-8 px-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-white"
                      />
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] font-mono text-zinc-500">Max:</span>
                        <input
                          type="number"
                          value={crit.max_marks}
                          onChange={(e) => {
                            const updated = [...rubric];
                            updated[idx].max_marks = Number(e.target.value) || 0;
                            setRubric(updated);
                          }}
                          className="w-14 h-8 px-2 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-center text-amber-400 font-mono font-bold"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setRubric(rubric.filter((_, i) => i !== idx))}
                        className="w-8 h-8 rounded-lg bg-zinc-950 text-zinc-500 hover:text-rose-400 flex items-center justify-center cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="pt-4 border-t border-zinc-800 flex gap-3">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="flex-1 h-11 rounded-xl bg-zinc-900 text-zinc-400 font-bold text-xs cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 h-11 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-extrabold text-xs cursor-pointer shadow-lg shadow-emerald-500/20"
                >
                  Save Event & Rubric
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
