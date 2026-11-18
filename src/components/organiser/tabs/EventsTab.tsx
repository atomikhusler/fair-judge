import React, { useState, useEffect, useMemo, useCallback, useRef, useDeferredValue } from 'react';
import { createPortal } from 'react-dom';
import { 
  Plus, 
  Search, 
  Edit3, 
  Trash2, 
  Archive, 
  ArchiveRestore,
  Users, 
  Gavel, 
  X, 
  Check, 
  AlertTriangle, 
  Copy, 
  Bookmark, 
  Sparkles,
  Eye,
  UserPlus,
  ShieldCheck,
  Hash,
  School,
  GraduationCap,
  Calendar,
  Layers,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Lock,
  KeyRound,
  Scale,
  Minus
} from 'lucide-react';
import { 
  Organization, 
  SupabaseEvent, 
  SupabaseJudge, 
  SupabaseParticipant, 
  EventStatus,
  RubricCriterion 
} from '../../../lib/supabaseTypes';
import { dbService, generateUUID, subscribeToDatabase, supabase } from '../../../lib/supabase';
import { registerSyncCadence } from '../../../lib/syncEngine';
import { eventBus, areRecordsEqual } from '../../../lib/eventBus';
import { triggerHaptic } from '../../../lib/haptics';
import { DB_TABLES, matchesDbTable } from '../../../lib/dbTables';
import { ReadRetryBanner } from '../../common/ReadRetryBanner';
import { useToast } from '../../common/ToastProvider';
import { UnsavedChangesDialog } from '../../common/UnsavedChangesDialog';
import { useTaskScreenBackGuard } from '../../common/useTaskScreenBackGuard';
import {
  TaskScreen,
  useModalAccessibility,
  useVisualViewportOffset,
  scrollFocusedInputIntoView,
} from '../../common/TaskScreen';

interface EventsTabProps {
  organization: Organization;
  onOpenPublicView?: (eventId?: string) => void;
  onNavigateToLiveControl?: (eventId: string) => void;
  onNavigateToPeopleCreate?: (target: 'participant' | 'judge') => void;
}

type FilterStatus = 'all' | 'active' | 'upcoming' | 'draft' | 'ended' | 'archived';

interface RubricItem {
  id: string;
  name: string;
  maxMarks: number;
}

interface DraftState {
  name: string;
  category: string;
  rubricCriteria: RubricItem[];
  savedAt: string;
}

const RUBRIC_PRESETS: Array<{ label: string; criteria: Array<{ name: string; maxMarks: number }> }> = [
  {
    label: 'Performing Arts (25 pts)',
    criteria: [
      { name: 'Rhythm & Choreography', maxMarks: 10 },
      { name: 'Stage Presence & Costume', maxMarks: 5 },
      { name: 'Synchronization & Technique', maxMarks: 10 },
    ],
  },
  {
    label: 'Debate & Elocution (30 pts)',
    criteria: [
      { name: 'Clarity of Argument & Logic', maxMarks: 10 },
      { name: 'Delivery, Tone & Pacing', maxMarks: 10 },
      { name: 'Rebuttal & Defense', maxMarks: 10 },
    ],
  },
  {
    label: 'Science & Pitch (50 pts)',
    criteria: [
      { name: 'Innovation & Problem Fit', maxMarks: 20 },
      { name: 'Technical Execution / Prototype', maxMarks: 15 },
      { name: 'Viability & Presentation', maxMarks: 15 },
    ],
  },
];

interface EventFormPanelHeaderProps {
  step: 1 | 2;
  title: string;
  summary?: string;
  isComplete: boolean;
}

function EventFormPanelHeader({
  step,
  title,
  summary,
  isComplete,
}: EventFormPanelHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-2 pb-3 border-b border-stone-100 dark:border-zinc-900">
      <div className="flex items-center gap-2.5 min-w-0">
        <span
          className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center shrink-0 tabular-nums transition-colors ${
            isComplete
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30'
              : 'bg-stone-100 dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 border border-stone-200 dark:border-zinc-800'
          }`}
        >
          {step}
        </span>
        <h3 className="text-sm font-bold text-stone-900 dark:text-white truncate">
          {title}
        </h3>
      </div>
      {(summary || isComplete) && (
        <div className="flex items-center gap-1.5 min-w-0 shrink">
          {summary && (
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 truncate tabular-nums">
              {summary}
            </span>
          )}
          {isComplete && (
            <span
              aria-label={`${title} complete`}
              className="w-4 h-4 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0"
            >
              <Check className="w-2.5 h-2.5 stroke-[3]" />
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function EventsTab({
  organization,
  onOpenPublicView,
  onNavigateToLiveControl,
  onNavigateToPeopleCreate,
}: EventsTabProps) {
  // ========================================================
  // 1. MAIN EVENT LIBRARY STATE (Optimistically seeded from local cache)
  // ========================================================
  const [events, setEvents] = useState<SupabaseEvent[]>(() =>
    dbService.getCachedEvents(organization.org_id)
  );
  const [participants, setParticipants] = useState<SupabaseParticipant[]>(() =>
    dbService.getCachedParticipants(organization.org_id)
  );
  const [judges, setJudges] = useState<SupabaseJudge[]>(() =>
    dbService.getCachedJudges(organization.org_id)
  );
  const [scoresMap, setScoresMap] = useState<Record<string, number>>(() => {
    const cachedScores = dbService.getCachedScores(organization.org_id);
    const counts: Record<string, number> = {};
    cachedScores.forEach((sc) => {
      counts[sc.event_id] = (counts[sc.event_id] || 0) + 1;
    });
    return counts;
  });

  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearch = useDeferredValue(searchQuery);
  const { showToast } = useToast();
  const [readError, setReadError] = useState<string | null>(null);
  const [isRetryingRead, setIsRetryingRead] = useState(false);
  const readErrorRef = useRef<string | null>(null);
  const loadRequestIdRef = useRef(0);

  useEffect(() => {
    readErrorRef.current = readError;
  }, [readError]);

  // Tiered Deletion Matrix & Custom Framer-Style Modal State (Phase 13.9)
  const [eventModalState, setEventModalState] = useState<{
    isOpen: boolean;
    type: 'delete_draft' | 'delete_ended' | 'duplicate';
    eventId: string;
    eventName: string;
    status?: EventStatus;
    canDelete?: boolean;
  } | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [masterPasswordInput, setMasterPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // ========================================================
  // 2. FULL-SCREEN CREATE / EDIT EVENT PAGE STATE
  // ========================================================
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [hasExistingScores, setHasExistingScores] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showDraftBanner, setShowDraftBanner] = useState(false);
  const [cachedDraft, setCachedDraft] = useState<DraftState | null>(null);
  const [isUnsavedExitModalOpen, setIsUnsavedExitModalOpen] = useState(false);

  // Basic Details: Only Title & Category (Date removed as requested)
  const [eventName, setEventName] = useState('');
  const [eventCategory, setEventCategory] = useState('');
  const [categorySuggested, setCategorySuggested] = useState(false);
  const [eventTitleTouched, setEventTitleTouched] = useState(false);
  const [rubricTouched, setRubricTouched] = useState(false);
  const [rubricCriteria, setRubricCriteria] = useState<RubricItem[]>([
    { id: generateUUID(), name: 'Concept & Originality', maxMarks: 10 },
    { id: generateUUID(), name: 'Execution & Technique', maxMarks: 10 },
    { id: generateUUID(), name: 'Defense & Q&A', maxMarks: 5 },
  ]);

  const eventTitleInputRef = useRef<HTMLInputElement>(null);
  const eventCategoryInputRef = useRef<HTMLInputElement>(null);
  const criterionNameRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const criterionMarksRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const criterionRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const rubricCriteriaRef = useRef<RubricItem[]>(rubricCriteria);
  rubricCriteriaRef.current = rubricCriteria;
  const pendingFocusCriterionIdRef = useRef<string | null>(null);
  const [editingMarksText, setEditingMarksText] = useState<Record<string, string>>({});
  const [draggingCriterionId, setDraggingCriterionId] = useState<string | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const syncCriterionTextareaHeight = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(32, el.scrollHeight)}px`;
  }, []);

  useEffect(() => {
    const targetId = pendingFocusCriterionIdRef.current;
    if (!targetId) return;
    pendingFocusCriterionIdRef.current = null;
    const input = criterionNameRefs.current[targetId];
    if (input) {
      input.focus();
    }
  }, [rubricCriteria]);

  useEffect(() => {
    if (!isWizardOpen) {
      setEditingMarksText({});
      setDraggingCriterionId(null);
      dragCleanupRef.current?.();
      return;
    }
    const raf = window.requestAnimationFrame(() => {
      rubricCriteria.forEach((c) => {
        syncCriterionTextareaHeight(criterionNameRefs.current[c.id] || null);
      });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [isWizardOpen, rubricCriteria, syncCriterionTextareaHeight]);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  // Org-derived Event Category suggestions, falling back to Senior/Junior/Classical when none exist
  const { categoryChips, defaultSuggestedCategory } = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    events.forEach((evt) => {
      const raw = (evt.category || '').trim();
      if (!raw || raw.toLowerCase() === 'general') return;
      const key = raw.toLowerCase();
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { label: raw, count: 1 });
      }
    });
    const sortedOrgCategories = Array.from(counts.values())
      .sort((a, b) => b.count - a.count)
      .map((item) => item.label)
      .slice(0, 8);
    const chips = sortedOrgCategories.length > 0 ? sortedOrgCategories : ['Senior', 'Junior', 'Classical'];
    return {
      categoryChips: chips,
      defaultSuggestedCategory: chips[0] || 'Senior',
    };
  }, [events]);

  // ========================================================
  // 3. EVENT PARTICIPANTS & JUDGES FULL-SCREEN / DOSSIER MODALS
  // ========================================================
  const [activeParticipantsEventId, setActiveParticipantsEventId] = useState<string | null>(null);
  const [activeJudgesEventId, setActiveJudgesEventId] = useState<string | null>(null);
  const [dossierEventId, setDossierEventId] = useState<string | null>(null);

  // Derive active modal objects from the events list to avoid circular state updates
  const activeParticipantsModalEvent = useMemo(() => {
    if (!activeParticipantsEventId) return null;
    return events.find((e) => e.id === activeParticipantsEventId) || null;
  }, [events, activeParticipantsEventId]);

  const activeJudgesModalEvent = useMemo(() => {
    if (!activeJudgesEventId) return null;
    return events.find((e) => e.id === activeJudgesEventId) || null;
  }, [events, activeJudgesEventId]);

  const dossierEvent = useMemo(() => {
    if (!dossierEventId) return null;
    return events.find((e) => e.id === dossierEventId) || null;
  }, [events, dossierEventId]);

  // Active Roster ID sets for O(1) relational existence checks (Eradicates ghost counts - Phase 13.7)
  const activeParticipantIdSet = useMemo(() => {
    return new Set(
      participants
        .filter((p) => p.is_active !== false)
        .map((p) => p.id)
    );
  }, [participants]);

  const activeJudgeIdSet = useMemo(() => {
    return new Set(
      judges
        .filter((j) => j.is_active !== false)
        .map((j) => j.id)
    );
  }, [judges]);

  // Normalized O(1) entity lookups (Directive 2)
  const participantMap = useMemo(() => {
    return new Map(participants.map((p) => [p.id, p]));
  }, [participants]);

  const judgeMap = useMemo(() => {
    return new Map(judges.map((j) => [j.id, j]));
  }, [judges]);

  // Modal local search, view mode & dedicated picker state
  const [participantSearch, setParticipantSearch] = useState('');
  const [judgeSearch, setJudgeSearch] = useState('');
  const [participantViewMode, setParticipantViewMode] = useState<'lineup' | 'order'>('lineup');

  const [isParticipantPickerOpen, setIsParticipantPickerOpen] = useState(false);
  const [participantPickerSearch, setParticipantPickerSearch] = useState('');
  const [selectedPickerParticipantIds, setSelectedPickerParticipantIds] = useState<string[]>([]);
  const [isBatchEnrolling, setIsBatchEnrolling] = useState(false);

  const [isJudgePickerOpen, setIsJudgePickerOpen] = useState(false);
  const [judgePickerSearch, setJudgePickerSearch] = useState('');
  const [selectedPickerJudgeIds, setSelectedPickerJudgeIds] = useState<string[]>([]);
  const [isBatchAssigningJudges, setIsBatchAssigningJudges] = useState(false);

  const handleCloseParticipantPicker = useCallback(() => {
    setIsParticipantPickerOpen(false);
    setParticipantPickerSearch('');
    setSelectedPickerParticipantIds([]);
  }, []);

  const handleCloseJudgePicker = useCallback(() => {
    setIsJudgePickerOpen(false);
    setJudgePickerSearch('');
    setSelectedPickerJudgeIds([]);
  }, []);

  // Clean Modal Close Helpers
  const handleCloseParticipantsModal = useCallback(() => {
    setActiveParticipantsEventId(null);
    setParticipantSearch('');
    setParticipantViewMode('lineup');
    setIsParticipantPickerOpen(false);
    setParticipantPickerSearch('');
    setSelectedPickerParticipantIds([]);
  }, []);

  const handleCloseJudgesModal = useCallback(() => {
    setActiveJudgesEventId(null);
    setJudgeSearch('');
    setIsJudgePickerOpen(false);
    setJudgePickerSearch('');
    setSelectedPickerJudgeIds([]);
  }, []);

  const handleCreateNewFromPicker = useCallback(
    (target: 'participant' | 'judge') => {
      if (target === 'participant') {
        handleCloseParticipantsModal();
      } else {
        handleCloseJudgesModal();
      }
      onNavigateToPeopleCreate?.(target);
    },
    [handleCloseJudgesModal, handleCloseParticipantsModal, onNavigateToPeopleCreate]
  );

  const unsavedExitDialogRef = useRef<HTMLDivElement>(null);
  const dossierDialogRef = useRef<HTMLDivElement>(null);
  const eventActionDialogRef = useRef<HTMLDivElement>(null);

  const isEventActionModalOpen = Boolean(eventModalState && eventModalState.isOpen);
  const eventActionKeyboardInset = useVisualViewportOffset(isEventActionModalOpen);

  useModalAccessibility({
    isOpen: isEventActionModalOpen,
    isTopmost: isEventActionModalOpen,
    onClose: () => {
      setEventModalState(null);
      setDeleteConfirmText('');
      setMasterPasswordInput('');
      setPasswordError(null);
    },
    containerRef: eventActionDialogRef,
  });

  useModalAccessibility({
    isOpen: isUnsavedExitModalOpen,
    isTopmost: isUnsavedExitModalOpen && !isEventActionModalOpen,
    onClose: () => setIsUnsavedExitModalOpen(false),
    containerRef: unsavedExitDialogRef,
  });

  useModalAccessibility({
    isOpen: Boolean(dossierEvent),
    isTopmost: Boolean(dossierEvent) && !isEventActionModalOpen && !isUnsavedExitModalOpen,
    onClose: () => setDossierEventId(null),
    containerRef: dossierDialogRef,
  });

  // Storage key for auto-save draft recovery
  const draftStorageKey = useMemo(
    () => `fairjudge_event_draft_${organization.org_id.toUpperCase()}`,
    [organization.org_id]
  );



  // ========================================================
  // 4. EVENT-DRIVEN SYNC (Coordinated ReadResult + EventBus)
  // ========================================================
  const loadData = useCallback(
    async (force: boolean = false) => {
      const reqId = ++loadRequestIdRef.current;
      if (force) setIsRetryingRead(true);

      try {
        const [eventsRes, participantsRes, judgesRes, scoresRes] = await Promise.all([
          dbService.getEventsResult(organization.org_id, force),
          dbService.getParticipantsResult(organization.org_id, force),
          dbService.getJudgesResult(organization.org_id, force),
          dbService.getOrgScoresResult(organization.org_id, force),
        ]);

        if (reqId !== loadRequestIdRef.current) return;

        setEvents((prev) => (areRecordsEqual(prev, eventsRes.data) ? prev : eventsRes.data));
        setParticipants((prev) =>
          areRecordsEqual(prev, participantsRes.data) ? prev : participantsRes.data
        );
        setJudges((prev) => (areRecordsEqual(prev, judgesRes.data) ? prev : judgesRes.data));

        const scoreCounts: Record<string, number> = {};
        scoresRes.data.forEach((sc) => {
          scoreCounts[sc.event_id] = (scoreCounts[sc.event_id] || 0) + 1;
        });
        setScoresMap((prev) => {
          const prevKeys = Object.keys(prev);
          const nextKeys = Object.keys(scoreCounts);
          if (prevKeys.length === nextKeys.length && prevKeys.every((k) => prev[k] === scoreCounts[k])) {
            return prev;
          }
          return scoreCounts;
        });

        const firstFailure = [eventsRes, participantsRes, judgesRes, scoresRes].find((r) => !r.ok);
        if (firstFailure) {
          setReadError(firstFailure.error || 'Showing cached data. Unable to reach server.');
        } else {
          setReadError(null);
        }
      } catch (err: any) {
        if (reqId !== loadRequestIdRef.current) return;
        setReadError(err?.message || 'Showing cached data. Unable to reach server.');
      } finally {
        if (force && reqId === loadRequestIdRef.current) {
          setIsRetryingRead(false);
        }
      }
    },
    [organization.org_id]
  );

  useEffect(() => {
    const releaseCadence = registerSyncCadence('normal');
    setEvents(dbService.getCachedEvents(organization.org_id));
    setParticipants(dbService.getCachedParticipants(organization.org_id));
    setJudges(dbService.getCachedJudges(organization.org_id));
    const cachedScores = dbService.getCachedScores(organization.org_id);
    const initialScoreCounts: Record<string, number> = {};
    cachedScores.forEach((sc) => {
      initialScoreCounts[sc.event_id] = (initialScoreCounts[sc.event_id] || 0) + 1;
    });
    setScoresMap(initialScoreCounts);

    const unsubBus = eventBus.on('cache_updated', (payload) => {
      const table = payload?.table;
      if (!table || matchesDbTable(table, DB_TABLES.EVENTS)) {
        setEvents((prev) => {
          const next = dbService.getCachedEvents(organization.org_id);
          return areRecordsEqual(prev, next) ? prev : next;
        });
      }
      if (!table || matchesDbTable(table, DB_TABLES.PARTICIPANTS)) {
        setParticipants((prev) => {
          const next = dbService.getCachedParticipants(organization.org_id);
          return areRecordsEqual(prev, next) ? prev : next;
        });
      }
      if (!table || matchesDbTable(table, DB_TABLES.JUDGES)) {
        setJudges((prev) => {
          const next = dbService.getCachedJudges(organization.org_id);
          return areRecordsEqual(prev, next) ? prev : next;
        });
      }
      if (!table || matchesDbTable(table, DB_TABLES.SCORES)) {
        const freshCachedScores = dbService.getCachedScores(organization.org_id);
        const scoreCounts: Record<string, number> = {};
        freshCachedScores.forEach((sc) => {
          scoreCounts[sc.event_id] = (scoreCounts[sc.event_id] || 0) + 1;
        });
        setScoresMap((prev) => {
          const prevKeys = Object.keys(prev);
          const nextKeys = Object.keys(scoreCounts);
          if (
            prevKeys.length === nextKeys.length &&
            prevKeys.every((k) => prev[k] === scoreCounts[k])
          ) {
            return prev;
          }
          return scoreCounts;
        });
      }
    });

    const unsubDb = subscribeToDatabase((table) => {
      if (
        matchesDbTable(
          table,
          DB_TABLES.EVENTS,
          DB_TABLES.PARTICIPANTS,
          DB_TABLES.JUDGES,
          DB_TABLES.SCORES
        )
      ) {
        void loadData(false);
      }
    });

    const handleVisibilityOrOnline = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      if (readErrorRef.current) {
        void loadData(true);
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityOrOnline);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleVisibilityOrOnline);
    }

    void loadData(false);

    return () => {
      releaseCadence();
      unsubBus();
      unsubDb();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityOrOnline);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleVisibilityOrOnline);
      }
    };
  }, [organization.org_id, loadData]);

  // Draft recovery check (strictly skip hydration while editingEventId is set, with 24h TTL)
  const checkForDraft = useCallback((): DraftState | null => {
    if (editingEventId) return null; // Skip hydration while editing an existing event
    try {
      const saved = localStorage.getItem(draftStorageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as DraftState;
        // Enforce 24h TTL
        if (parsed.savedAt && Date.now() - new Date(parsed.savedAt).getTime() > 24 * 3600 * 1000) {
          localStorage.removeItem(draftStorageKey);
          return null;
        }
        if (parsed.name?.trim()) {
          return parsed;
        }
      }
    } catch {}
    return null;
  }, [draftStorageKey, editingEventId]);

  // Auto-save form state to localStorage
  useEffect(() => {
    if (!isWizardOpen || editingEventId || !isDirty) return;

    const timer = setTimeout(() => {
      try {
        const stateToSave: DraftState = {
          name: eventName,
          category: eventCategory,
          rubricCriteria,
          savedAt: new Date().toISOString(),
        };
        localStorage.setItem(draftStorageKey, JSON.stringify(stateToSave));
      } catch (err) {
        console.warn('Failed to auto-save draft:', err);
      }
    }, 800);

    return () => clearTimeout(timer);
  }, [isWizardOpen, editingEventId, isDirty, eventName, eventCategory, rubricCriteria, draftStorageKey]);

  const clearDraft = useCallback(() => {
    try {
      localStorage.removeItem(draftStorageKey);
      setCachedDraft(null);
      setShowDraftBanner(false);
    } catch {}
  }, [draftStorageKey]);

  // ========================================================
  // 5. FULL-SCREEN CREATE EVENT FLOW
  // ========================================================
  const handleOpenCreateWizard = () => {
    setEditingEventId(null);
    setHasExistingScores(false);
    setEventTitleTouched(false);
    setRubricTouched(false);

    const draft = checkForDraft();
    if (draft) {
      setCachedDraft(draft);
      setShowDraftBanner(true);
    } else {
      setShowDraftBanner(false);
      setCachedDraft(null);
    }

    setEventName('');
    setEventCategory(defaultSuggestedCategory);
    setCategorySuggested(Boolean(defaultSuggestedCategory));
    setRubricCriteria([
      { id: generateUUID(), name: 'Concept & Originality', maxMarks: 10 },
      { id: generateUUID(), name: 'Execution & Technique', maxMarks: 10 },
      { id: generateUUID(), name: 'Defense & Q&A', maxMarks: 5 },
    ]);

    setIsDirty(false);
    setIsWizardOpen(true);
  };

  const handleResumeDraft = () => {
    if (!cachedDraft) return;
    setEventName(cachedDraft.name || '');
    setEventCategory(cachedDraft.category || '');
    setCategorySuggested(false);
    setEventTitleTouched(false);
    setRubricTouched(false);
    setRubricCriteria(cachedDraft.rubricCriteria || []);
    setShowDraftBanner(false);
    setIsDirty(true);
    showToast('Draft recovered successfully.');
  };

  const handleDiscardDraft = () => {
    clearDraft();
    setEventName('');
    setEventCategory(defaultSuggestedCategory);
    setCategorySuggested(Boolean(defaultSuggestedCategory));
    setEventTitleTouched(false);
    setRubricTouched(false);
    setRubricCriteria([
      { id: generateUUID(), name: 'Concept & Originality', maxMarks: 10 },
      { id: generateUUID(), name: 'Execution & Technique', maxMarks: 10 },
      { id: generateUUID(), name: 'Defense & Q&A', maxMarks: 5 },
    ]);
    setIsDirty(false);
    showToast('Draft cleared. Starting fresh.');
  };

  const handleCloseWizard = useCallback(() => {
    if (isDirty) {
      setIsUnsavedExitModalOpen(true);
      return;
    }
    setIsWizardOpen(false);
    setIsDirty(false);
    setShowDraftBanner(false);
  }, [isDirty]);

  const handleForceDiscardAndExit = () => {
    clearDraft();
    setIsUnsavedExitModalOpen(false);
    setIsWizardOpen(false);
    setIsDirty(false);
    setShowDraftBanner(false);
  };

  const handleSaveDraftAndExit = () => {
    if (!editingEventId) {
      try {
        const stateToSave: DraftState = {
          name: eventName,
          category: eventCategory,
          rubricCriteria,
          savedAt: new Date().toISOString(),
        };
        localStorage.setItem(draftStorageKey, JSON.stringify(stateToSave));
      } catch (err) {
        console.warn('Failed to save event draft:', err);
      }
      showToast('Draft saved locally.');
    }
    setIsUnsavedExitModalOpen(false);
    setIsWizardOpen(false);
    setIsDirty(false);
    setShowDraftBanner(false);
  };

  useTaskScreenBackGuard({
    isOpen: isWizardOpen,
    onBack: handleCloseWizard,
    hasNestedOverlay: Boolean(isUnsavedExitModalOpen || isEventActionModalOpen),
    onCloseNested: () => {
      if (isUnsavedExitModalOpen) setIsUnsavedExitModalOpen(false);
    },
  });

  // ========================================================
  // 6. PROHIBITED RULE ENFORCEMENT & EDIT / DELETE DISPATCH
  // ========================================================
  const handleEditClick = async (evt: SupabaseEvent) => {
    const status = (evt.status || 'draft').toLowerCase();

    // STRICT RULE: No one can edit event once event is live
    if (status === 'active') {
      showToast('Prohibited: Cannot edit event settings while event is live.');
      return;
    }

    // STRICT RULE: Once event is ended/completed, no one can edit event
    if (status === 'ended' || status === 'archived') {
      showToast('Prohibited: Cannot edit an event once it has ended.');
      return;
    }

    // Allowed for upcoming or draft
    try {
      const scores = await dbService.getScores(evt.id);
      setEditingEventId(evt.id);
      setHasExistingScores(scores.length > 0);
      setShowDraftBanner(false);
      setEventTitleTouched(false);
      setRubricTouched(false);

      setEventName(evt.name || '');
      setEventCategory(evt.category || '');
      setCategorySuggested(false);

      const criteria = (evt.rubric_schema || evt.rubric || []).map((c) => ({
        id: c.id || generateUUID(),
        name: c.name || '',
        maxMarks: Number(c.max_marks) || 10,
      }));
      setRubricCriteria(
        criteria.length > 0
          ? criteria
          : [{ id: generateUUID(), name: 'Evaluation Metric', maxMarks: 10 }]
      );

      setIsDirty(false);
      setIsWizardOpen(true);
    } catch (err) {
      console.error('Failed to open event for edit:', err);
      showToast('Error opening event editor.');
    }
  };

  const handleToggleArchive = async (e: React.MouseEvent, evt: SupabaseEvent) => {
    e.stopPropagation();
    const willArchive = !evt.is_archived;
    try {
      await dbService.updateEvent(evt.id, { is_archived: willArchive });
      setEvents((prev) =>
        prev.map((item) => (item.id === evt.id ? { ...item, is_archived: willArchive } : item))
      );
      showToast(
        willArchive
          ? `Event "${evt.name}" moved to archive.`
          : `Event "${evt.name}" restored from archive.`
      );
    } catch (err) {
      console.error('Failed to toggle archive status:', err);
      showToast('Failed to update event archive status.');
    }
  };

  const handleDeleteClick = (e: React.MouseEvent, evt: SupabaseEvent) => {
    e.stopPropagation();
    const status = (evt.status || 'draft').toLowerCase();

    // 1. Active Events: Delete button visible at 50% opacity. Does NOT open modal. Triggers global toast.
    if (status === 'active') {
      showToast('Action Denied: Cannot delete an active event. Pause or End it first.');
      return;
    }

    // 2. Ended Events (Offline Auth): Prompt for Organization Master Password
    if (status === 'ended' || status === 'archived') {
      setMasterPasswordInput('');
      setPasswordError(null);
      setEventModalState({
        isOpen: true,
        type: 'delete_ended',
        eventId: evt.id,
        eventName: evt.name,
        status: evt.status,
      });
      return;
    }

    // 3. Draft / Upcoming / Paused: Standard double-confirmation modal (type DELETE or name)
    setDeleteConfirmText('');
    setEventModalState({
      isOpen: true,
      type: 'delete_draft',
      eventId: evt.id,
      eventName: evt.name,
      status: evt.status,
    });
  };

  const handleDuplicateClick = (e: React.MouseEvent, evt: SupabaseEvent) => {
    e.stopPropagation();
    setEventModalState({
      isOpen: true,
      type: 'duplicate',
      eventId: evt.id,
      eventName: evt.name,
    });
  };

  const handleConfirmModalAction = async () => {
    if (!eventModalState) return;
    const { type, eventId, eventName: targetName } = eventModalState;

    if (type === 'delete_draft') {
      try {
        await dbService.deleteEvent(eventId);
        showToast(`Event "${targetName}" was permanently deleted.`);
        if (isWizardOpen && editingEventId === eventId) {
          setIsWizardOpen(false);
          setIsDirty(false);
        }
        await loadData();
      } catch (err) {
        console.error('Failed to delete event:', err);
        showToast('Action failed.');
      } finally {
        setEventModalState(null);
        setDeleteConfirmText('');
      }
    } else if (type === 'delete_ended') {
      const enteredPassword = masterPasswordInput.trim();
      if (!enteredPassword) {
        setPasswordError('Master password is required.');
        return;
      }

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        showToast('Needs internet to confirm deletion.');
        return;
      }

      try {
        const { data, error } = await supabase.rpc('org_verify_password', {
          p_org_id: organization.org_id,
          p_password: enteredPassword,
        });

        if (error) throw error;

        const res = data as any;
        if (!res || !res.ok) {
          const errCode = res?.error || res?.reason;
          if (errCode === 'too_many_attempts') {
            setPasswordError('Too many attempts. Try again in 15 minutes.');
            showToast('Too many attempts. Try again in 15 minutes.');
            return;
          }
          setPasswordError('Incorrect master password.');
          showToast('Incorrect master password.');
          return;
        }
      } catch (authErr: any) {
        const msg = authErr.message || '';
        if (msg.includes('too_many_attempts')) {
          setPasswordError('Too many attempts. Try again in 15 minutes.');
          showToast('Too many attempts. Try again in 15 minutes.');
          return;
        }
        setPasswordError('Incorrect master password.');
        showToast('Incorrect master password.');
        return;
      }

      try {
        await dbService.deleteEvent(eventId);
        showToast(`Event "${targetName}" permanently deleted.`);
        if (isWizardOpen && editingEventId === eventId) {
          setIsWizardOpen(false);
          setIsDirty(false);
        }
        setEventModalState(null);
        setMasterPasswordInput('');
        setPasswordError(null);
        await loadData();
      } catch (err) {
        console.error('Failed to delete ended event:', err);
        showToast('Action failed.');
      }
    } else if (type === 'duplicate') {
      const evt = events.find((e) => e.id === eventId);
      if (!evt) {
        setEventModalState(null);
        return;
      }
      try {
        const dup = await dbService.createEvent({
          org_id: organization.org_id,
          name: `${evt.name} (Copy)`,
          category: evt.category || 'General',
          date: new Date().toISOString().split('T')[0],
          status: 'draft',
          rubric_schema: evt.rubric_schema || evt.rubric || [],
          assigned_judges: evt.assigned_judges || [],
          assigned_participants: evt.assigned_participants || [],
        });
        if (evt.participant_sl_numbers) {
          await dbService.updateEvent(dup.id, {
            participant_sl_numbers: evt.participant_sl_numbers,
          });
        }
        showToast(`Duplicated "${evt.name}" as draft.`);
        await loadData();
      } catch (err) {
        console.error('Failed to duplicate event:', err);
        showToast('Duplication failed.');
      } finally {
        setEventModalState(null);
      }
    }
  };

  // ========================================================
  // 7. COMPACT RUBRIC BUILDER MATH & ACTIONS
  // ========================================================
  const totalRubricMarks = useMemo(() => {
    return rubricCriteria.reduce((sum, item) => sum + (Number(item.maxMarks) || 0), 0);
  }, [rubricCriteria]);

  const handleAddCriterion = (focusNew: boolean = false) => {
    if (hasExistingScores) {
      showToast('Rubric schema is locked to preserve ledger integrity.');
      return;
    }
    const newId = generateUUID();
    pendingFocusCriterionIdRef.current = focusNew ? newId : null;
    setIsDirty(true);
    setRubricCriteria((prev) => [
      ...prev,
      { id: newId, name: '', maxMarks: 10 },
    ]);
  };

  const handleUpdateCriterion = (id: string, field: 'name' | 'maxMarks', val: any) => {
    if (field === 'maxMarks' && hasExistingScores) {
      showToast('Max marks locked to preserve ledger integrity.');
      return;
    }
    setIsDirty(true);
    setRubricCriteria((prev) =>
      prev.map((c) => (c.id === id ? { ...c, [field]: val } : c))
    );
  };

  const handleRemoveCriterion = (id: string) => {
    if (hasExistingScores) {
      showToast('Rubric criteria cannot be deleted when scores exist.');
      return;
    }
    if (rubricCriteria.length <= 1) return;
    const removedIndex = rubricCriteria.findIndex((c) => c.id === id);
    if (removedIndex === -1) return;
    const removedItem = rubricCriteria[removedIndex];

    setIsDirty(true);
    setRubricCriteria((prev) => prev.filter((c) => c.id !== id));

    const label = removedItem.name.trim()
      ? `Removed "${removedItem.name.trim()}".`
      : `Removed criterion #${removedIndex + 1}.`;

    showToast(label, 'info', 5000, {
      label: 'Undo',
      onClick: () => {
        setIsDirty(true);
        setRubricCriteria((prev) => {
          if (prev.some((c) => c.id === removedItem.id)) return prev;
          const next = [...prev];
          const insertAt = Math.min(removedIndex, next.length);
          next.splice(insertAt, 0, removedItem);
          return next;
        });
      },
    });
  };

  const handleMoveCriterion = useCallback(
    (index: number, direction: -1 | 1) => {
      if (hasExistingScores) {
        showToast('Rubric schema is locked to preserve ledger integrity.');
        return;
      }
      const targetIdx = index + direction;
      if (targetIdx < 0 || targetIdx >= rubricCriteria.length) return;
      setIsDirty(true);
      setRubricCriteria((prev) => {
        const next = [...prev];
        const [moved] = next.splice(index, 1);
        next.splice(targetIdx, 0, moved);
        return next;
      });
      triggerHaptic('tick');
    },
    [hasExistingScores, rubricCriteria.length, showToast]
  );

  const handleCriterionPointerDown = useCallback(
    (criterionId: string, e: React.PointerEvent<HTMLElement>) => {
      if (hasExistingScores || rubricCriteria.length <= 1) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      // Ignore direct interactions on controls inside the row
      const eventTarget = e.target as HTMLElement | null;
      if (
        eventTarget &&
        eventTarget.closest('button, input, textarea, select') &&
        !eventTarget.closest('[data-criterion-handle="true"]')
      ) {
        return;
      }

      dragCleanupRef.current?.();

      const captureEl = e.currentTarget;
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;
      let holdTimer: number | null = null;
      let isDragActive = false;

      const finish = () => {
        if (holdTimer !== null) {
          window.clearTimeout(holdTimer);
          holdTimer = null;
        }
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        if (isDragActive) {
          try {
            if (captureEl.hasPointerCapture(pointerId)) {
              captureEl.releasePointerCapture(pointerId);
            }
          } catch {}
          setDraggingCriterionId(null);
        }
        if (dragCleanupRef.current === finish) {
          dragCleanupRef.current = null;
        }
      };

      const onPointerMove = (moveEvt: PointerEvent) => {
        if (moveEvt.pointerId !== pointerId) return;
        if (!isDragActive) {
          if (Math.abs(moveEvt.clientY - startY) > 8 || Math.abs(moveEvt.clientX - startX) > 8) {
            finish();
          }
          return;
        }

        const prev = rubricCriteriaRef.current;
        const currentIdx = prev.findIndex((c) => c.id === criterionId);
        if (currentIdx === -1) return;

        let targetIdx = currentIdx;
        for (let i = 0; i < prev.length; i++) {
          const rowEl = criterionRowRefs.current[prev[i].id];
          if (!rowEl) continue;
          const rect = rowEl.getBoundingClientRect();
          const midpoint = rect.top + rect.height / 2;
          if (i < currentIdx && moveEvt.clientY < midpoint) {
            targetIdx = i;
            break;
          }
          if (i > currentIdx && moveEvt.clientY > midpoint) {
            targetIdx = i;
          }
        }

        if (targetIdx === currentIdx) return;
        const next = [...prev];
        const [moved] = next.splice(currentIdx, 1);
        next.splice(targetIdx, 0, moved);
        rubricCriteriaRef.current = next;
        setRubricCriteria(next);
        setIsDirty(true);
        triggerHaptic('tick');
      };

      holdTimer = window.setTimeout(() => {
        holdTimer = null;
        isDragActive = true;
        try {
          captureEl.setPointerCapture(pointerId);
        } catch {}
        setDraggingCriterionId(criterionId);
        triggerHaptic('tick');
      }, 250);

      dragCleanupRef.current = finish;
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    },
    [hasExistingScores, rubricCriteria.length]
  );

  const handleApplyPreset = (preset: typeof RUBRIC_PRESETS[0]) => {
    if (hasExistingScores) {
      showToast('Rubric schema is locked for this event.');
      return;
    }
    setIsDirty(true);
    setRubricTouched(false);
    setRubricCriteria(
      preset.criteria.map((c) => ({
        id: generateUUID(),
        name: c.name,
        maxMarks: c.maxMarks,
      }))
    );
  };

  // ========================================================
  // 8. SAVE NEW / EDITED EVENT
  // ========================================================
  const hasValidCriterion = rubricCriteria.some((c) => c.name.trim().length > 0);
  const isFormValid = Boolean(eventName.trim()) && hasValidCriterion;
  const eventMissingReason = !eventName.trim()
    ? 'Add an event title to save'
    : !hasValidCriterion
    ? 'Add a criterion name to save'
    : null;

  const handleSaveEvent = async () => {
    setEventTitleTouched(true);
    setRubricTouched(true);

    if (!eventName.trim()) {
      showToast('Please provide an Event Title.');
      return;
    }

    const validCriteria = rubricCriteria.filter((c) => c.name.trim().length > 0);
    if (validCriteria.length === 0) {
      showToast('Please add at least one valid rubric criterion.');
      return;
    }

    setIsSubmitting(true);
    try {
      const formattedRubric: RubricCriterion[] = validCriteria.map((c) => ({
        id: c.id,
        name: c.name.trim(),
        max_marks: Number(c.maxMarks) || 10,
        weight: 1,
      }));

      if (editingEventId) {
        const existingEvent = events.find((e) => e.id === editingEventId);
        let derivedStatus: EventStatus = 'draft';
        if (
          existingEvent?.status === 'active' ||
          existingEvent?.status === 'ended' ||
          existingEvent?.status === 'paused' ||
          existingEvent?.status === 'archived'
        ) {
          derivedStatus = existingEvent.status;
        } else if (
          (existingEvent?.assigned_participants || []).length > 0 &&
          (existingEvent?.assigned_judges || []).length > 0
        ) {
          derivedStatus = 'ready';
        }

        await dbService.updateEvent(editingEventId, {
          name: eventName.trim(),
          category: eventCategory.trim() || 'General',
          status: derivedStatus,
          rubric_schema: formattedRubric,
          rubric: formattedRubric,
        });
        showToast(`Event "${eventName}" updated.`);
      } else {
        await dbService.createEvent({
          org_id: organization.org_id,
          name: eventName.trim(),
          category: eventCategory.trim() || 'General',
          date: new Date().toISOString().split('T')[0],
          status: 'draft',
          rubric_schema: formattedRubric,
          assigned_judges: [],
          assigned_participants: [],
        });
        showToast(`Event "${eventName}" created as draft.`);
      }

      clearDraft();
      await loadData();
      setIsWizardOpen(false);
      setIsDirty(false);
    } catch (err) {
      console.error('Failed to save event:', err);
      showToast('Error saving event. Please check inputs.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // ========================================================
  // 9. EVENT PARTICIPANTS MODAL MANAGEMENT WITH STRICT RULES
  // ========================================================
  const handleRemoveParticipantFromEvent = async (participantId: string) => {
    if (!activeParticipantsModalEvent) return;
    const status = (activeParticipantsModalEvent.status || 'draft').toLowerCase();

    // RULE: no one can remove participants once event is live
    if (status === 'active') {
      showToast('Prohibited: Cannot remove participants while event is live.');
      return;
    }

    // RULE: once event is ended or completed, no one can remove participants
    if (status === 'ended' || status === 'archived') {
      showToast('Prohibited: Cannot remove participants from an ended event.');
      return;
    }

    try {
      const updatedList = (activeParticipantsModalEvent.assigned_participants || []).filter(
        (id) => id !== participantId
      );
      const updatedSerialMap: Record<string, string> = {};
      updatedList.forEach((id, idx) => {
        updatedSerialMap[id] = String(idx + 1).padStart(2, '0');
      });

      const hasActiveP = updatedList.some((id) => activeParticipantIdSet.has(id));
      const hasActiveJ = (activeParticipantsModalEvent.assigned_judges || []).some((id) => activeJudgeIdSet.has(id));
      const isNowReady = hasActiveP && hasActiveJ;
      let newStatus: EventStatus = activeParticipantsModalEvent.status;
      if (status !== 'active' && status !== 'ended' && status !== 'archived' && status !== 'paused') {
        newStatus = isNowReady ? 'ready' : 'draft';
      }

      await dbService.updateEvent(activeParticipantsModalEvent.id, {
        assigned_participants: updatedList,
        participant_sl_numbers: updatedSerialMap,
        status: newStatus,
      });

      setEvents((prev) =>
        prev.map((e) =>
          e.id === activeParticipantsModalEvent.id
            ? { ...e, assigned_participants: updatedList, participant_sl_numbers: updatedSerialMap, status: newStatus }
            : e
        )
      );
      showToast('Participant unassigned.');
    } catch (err) {
      console.error('Failed to remove participant:', err);
      showToast('Error removing participant.');
    }
  };

  const handleBatchEnrollParticipantsToEvent = async (participantIds: string[]) => {
    if (!activeParticipantsModalEvent || participantIds.length === 0 || isBatchEnrolling) return;
    const status = (activeParticipantsModalEvent.status || 'draft').toLowerCase();

    if (activeParticipantsModalEvent.is_locked) {
      showToast('Prohibited: Roster is locked.');
      return;
    }

    // RULE: once event is ended, no one can add participants
    if (status === 'ended' || status === 'archived') {
      showToast('Prohibited: Cannot add participants to an ended event.');
      return;
    }

    const currentAssigned = activeParticipantsModalEvent.assigned_participants || [];
    const currentAssignedSet = new Set(currentAssigned);
    const toAdd = Array.from(new Set(participantIds)).filter(
      (id) => activeParticipantIdSet.has(id) && !currentAssignedSet.has(id)
    );
    if (toAdd.length === 0) return;

    setIsBatchEnrolling(true);
    try {
      const toAddSet = new Set(toAdd);
      const updatedList = [...currentAssigned, ...toAdd];
      const updatedSerialMap: Record<string, string> = {};
      updatedList.forEach((id, idx) => {
        updatedSerialMap[id] = String(idx + 1).padStart(2, '0');
      });

      const hasActiveP = updatedList.some((id) => toAddSet.has(id) || activeParticipantIdSet.has(id));
      const hasActiveJ = (activeParticipantsModalEvent.assigned_judges || []).some((id) =>
        activeJudgeIdSet.has(id)
      );
      const isNowReady = hasActiveP && hasActiveJ;
      let newStatus: EventStatus = activeParticipantsModalEvent.status;
      if (status !== 'active' && status !== 'ended' && status !== 'archived' && status !== 'paused') {
        newStatus = isNowReady ? 'ready' : 'draft';
      }

      await dbService.updateEvent(activeParticipantsModalEvent.id, {
        assigned_participants: updatedList,
        participant_sl_numbers: updatedSerialMap,
        status: newStatus,
      });

      setEvents((prev) =>
        prev.map((e) =>
          e.id === activeParticipantsModalEvent.id
            ? {
                ...e,
                assigned_participants: updatedList,
                participant_sl_numbers: updatedSerialMap,
                status: newStatus,
              }
            : e
        )
      );
      handleCloseParticipantPicker();
      showToast(
        toAdd.length === 1
          ? 'Participant enrolled in event.'
          : `${toAdd.length} participants enrolled in event.`
      );
    } catch (err) {
      console.error('Failed to enroll participants:', err);
      showToast('Error enrolling participants.');
    } finally {
      setIsBatchEnrolling(false);
    }
  };

  // Reorder performance lineup with auto-renumbering and active lockout
  const handleReorderParticipant = async (fromIdx: number, toIdx: number) => {
    if (!activeParticipantsModalEvent) return;
    const status = (activeParticipantsModalEvent.status || 'draft').toLowerCase();

    // The Active Lockout: If the event status === 'active', completely disable drag-and-drop
    if (status === 'active') {
      showToast('Lineup Locked: Performance order cannot be changed while event is live.');
      return;
    }
    if (status === 'ended' || status === 'archived') {
      showToast('Prohibited: Lineup cannot be modified for concluded event.');
      return;
    }

    const currentAssigned = [...(activeParticipantsModalEvent.assigned_participants || [])];
    if (fromIdx < 0 || fromIdx >= currentAssigned.length || toIdx < 0 || toIdx >= currentAssigned.length || fromIdx === toIdx) {
      return;
    }

    const [movedId] = currentAssigned.splice(fromIdx, 1);
    currentAssigned.splice(toIdx, 0, movedId);

    // Auto-Renumbering: 1st row = #01, 2nd row = #02
    const updatedSerialMap: Record<string, string> = { ...(activeParticipantsModalEvent.participant_sl_numbers || {}) };
    currentAssigned.forEach((id, idx) => {
      updatedSerialMap[id] = String(idx + 1).padStart(2, '0');
    });

    try {
      await dbService.updateEvent(activeParticipantsModalEvent.id, {
        assigned_participants: currentAssigned,
        participant_sl_numbers: updatedSerialMap,
      });

      setEvents((prev) =>
        prev.map((e) =>
          e.id === activeParticipantsModalEvent.id
            ? { ...e, assigned_participants: currentAssigned, participant_sl_numbers: updatedSerialMap }
            : e
        )
      );
      showToast('Lineup reordered & renumbered.');
    } catch (err) {
      console.error('Failed to reorder lineup:', err);
      showToast('Error updating lineup order.');
    }
  };

  // ========================================================
  // 10. EVENT JUDGES MODAL MANAGEMENT WITH STRICT RULES
  // ========================================================
  const handleToggleJudgeInEvent = async (judgeId: string) => {
    if (!activeJudgesModalEvent) return;
    const status = (activeJudgesModalEvent.status || 'draft').toLowerCase();

    // RULE: no one can add or remove judge once event is live
    if (status === 'active') {
      showToast('Prohibited: Cannot add or remove judges while event is live.');
      return;
    }

    // RULE: once event is ended or completed, no one can add or remove judge
    if (status === 'ended' || status === 'archived') {
      showToast('Prohibited: Cannot modify judges for an ended event.');
      return;
    }

    try {
      const currentJudges = activeJudgesModalEvent.assigned_judges || [];
      const isAssigned = currentJudges.includes(judgeId);
      const updatedJudges = isAssigned
        ? currentJudges.filter((id) => id !== judgeId)
        : [...currentJudges, judgeId];

      const hasActiveP = (activeJudgesModalEvent.assigned_participants || []).some((id) => activeParticipantIdSet.has(id));
      const hasActiveJ = updatedJudges.some((id) => (id === judgeId ? !isAssigned : activeJudgeIdSet.has(id)));
      const isNowReady = hasActiveP && hasActiveJ;
      let newStatus: EventStatus = activeJudgesModalEvent.status;
      if (status !== 'active' && status !== 'ended' && status !== 'archived' && status !== 'paused') {
        newStatus = isNowReady ? 'ready' : 'draft';
      }

      await dbService.updateEvent(activeJudgesModalEvent.id, {
        assigned_judges: updatedJudges,
        status: newStatus,
      });

      setEvents((prev) =>
        prev.map((e) =>
          e.id === activeJudgesModalEvent.id ? { ...e, assigned_judges: updatedJudges, status: newStatus } : e
        )
      );
      showToast(isAssigned ? 'Judge removed from jury.' : 'Judge assigned to jury.');
    } catch (err) {
      console.error('Failed to update judges:', err);
      showToast('Error updating jury assignments.');
    }
  };

  const handleBatchAssignJudgesToEvent = async (judgeIds: string[]) => {
    if (!activeJudgesModalEvent || judgeIds.length === 0 || isBatchAssigningJudges) return;
    const status = (activeJudgesModalEvent.status || 'draft').toLowerCase();

    if (activeJudgesModalEvent.is_locked) {
      showToast('Prohibited: Jury assignments are locked.');
      return;
    }

    // RULE: no one can add or remove judge once event is live
    if (status === 'active') {
      showToast('Prohibited: Cannot add or remove judges while event is live.');
      return;
    }

    // RULE: once event is ended or completed, no one can add or remove judge
    if (status === 'ended' || status === 'archived') {
      showToast('Prohibited: Cannot modify judges for an ended event.');
      return;
    }

    const currentJudges = activeJudgesModalEvent.assigned_judges || [];
    const currentJudgesSet = new Set(currentJudges);
    const toAdd = Array.from(new Set(judgeIds)).filter(
      (id) => activeJudgeIdSet.has(id) && !currentJudgesSet.has(id)
    );
    if (toAdd.length === 0) return;

    setIsBatchAssigningJudges(true);
    try {
      const toAddSet = new Set(toAdd);
      const updatedJudges = [...currentJudges, ...toAdd];

      const hasActiveP = (activeJudgesModalEvent.assigned_participants || []).some((id) =>
        activeParticipantIdSet.has(id)
      );
      const hasActiveJ = updatedJudges.some((id) => toAddSet.has(id) || activeJudgeIdSet.has(id));
      const isNowReady = hasActiveP && hasActiveJ;
      let newStatus: EventStatus = activeJudgesModalEvent.status;
      if (status !== 'active' && status !== 'ended' && status !== 'archived' && status !== 'paused') {
        newStatus = isNowReady ? 'ready' : 'draft';
      }

      await dbService.updateEvent(activeJudgesModalEvent.id, {
        assigned_judges: updatedJudges,
        status: newStatus,
      });

      setEvents((prev) =>
        prev.map((e) =>
          e.id === activeJudgesModalEvent.id
            ? { ...e, assigned_judges: updatedJudges, status: newStatus }
            : e
        )
      );
      handleCloseJudgePicker();
      showToast(
        toAdd.length === 1
          ? 'Judge assigned to jury.'
          : `${toAdd.length} judges assigned to jury.`
      );
    } catch (err) {
      console.error('Failed to assign judges:', err);
      showToast('Error updating jury assignments.');
    } finally {
      setIsBatchAssigningJudges(false);
    }
  };

  // ========================================================
  // 11. FILTER & SEARCH LOGIC (Relational Ghost-Filtered Derived State - Phase 13.7)
  // ========================================================
  const statusCounts = useMemo(() => {
    const counts = { all: 0, active: 0, upcoming: 0, draft: 0, ended: 0, archived: 0 };
    events.forEach((e) => {
      const st = (e.status || 'draft').toLowerCase();
      const isArchived = Boolean(e.is_archived) || st === 'archived';
      if (isArchived) {
        counts.archived++;
        return;
      }

      counts.all++;
      const hasActiveParticipants = (e.assigned_participants || []).some((id) => activeParticipantIdSet.has(id));
      const hasActiveJudges = (e.assigned_judges || []).some((id) => activeJudgeIdSet.has(id));
      const hasBoth = hasActiveParticipants && hasActiveJudges;

      if (st === 'active' || st === 'paused') counts.active++;
      else if (st === 'ended') counts.ended++;
      else if (st === 'ready' || st === 'upcoming' || (st === 'draft' && hasBoth)) counts.upcoming++;
      else counts.draft++;
    });
    return counts;
  }, [events, activeParticipantIdSet, activeJudgeIdSet]);

  const filteredEvents = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    const isGlobalSearch = query !== '';

    return events.filter((e) => {
      const matchesSearch =
        query === '' ||
        e.name.toLowerCase().includes(query) ||
        (e.category && e.category.toLowerCase().includes(query));

      if (!matchesSearch) return false;

      const st = (e.status || 'draft').toLowerCase();
      const isArchived = Boolean(e.is_archived) || st === 'archived';

      if (filterStatus === 'archived') {
        return isArchived;
      }

      // ARCHIVE LOGIC ("Inbox Zero"):
      // Archived events show under the Archived tab and in global search under All,
      // and never leak into non-archived status tabs.
      if (filterStatus === 'all') {
        return isGlobalSearch ? true : !isArchived;
      }

      if (isArchived) return false;

      const hasActiveParticipants = (e.assigned_participants || []).some((id) => activeParticipantIdSet.has(id));
      const hasActiveJudges = (e.assigned_judges || []).some((id) => activeJudgeIdSet.has(id));
      const hasBoth = hasActiveParticipants && hasActiveJudges;
      const isActiveOrPaused = st === 'active' || st === 'paused';
      const isEnded = st === 'ended';
      const isReadyOrUpcoming = st === 'ready' || st === 'upcoming' || (st === 'draft' && hasBoth);

      if (filterStatus === 'active') return isActiveOrPaused;
      if (filterStatus === 'ended') return isEnded;
      if (filterStatus === 'upcoming') return isReadyOrUpcoming;
      if (filterStatus === 'draft') return !isActiveOrPaused && !isEnded && !isReadyOrUpcoming;
      return true;
    });
  }, [events, deferredSearch, filterStatus, activeParticipantIdSet, activeJudgeIdSet]);

  return (
    <>

      {/* ======================================================== */}
      {/* DEDICATED NATIVE SCROLL CONTAINER FOR EVENTS TAB         */}
      {/* ======================================================== */}
      <div className="flex-1 overflow-y-auto px-4 pb-32 text-stone-900 dark:text-stone-100 relative">
        
        {/* ======================================================== */}
        {/* STICKY COMMAND AREA (Search, Filters, Refined Button)     */}
        {/* ======================================================== */}
        <div className="sticky top-0 z-40 bg-stone-50 dark:bg-black pb-3 pt-2 space-y-3 mb-5">
          {/* Search bar + Static Desktop Action Button */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-stone-400 dark:text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search events by title or category..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full min-h-[44px] pl-10 pr-10 text-sm bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-xl text-stone-900 dark:text-white placeholder:text-stone-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-colors motion-reduce:transition-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 dark:hover:text-zinc-300 p-1 cursor-pointer md:min-w-[44px] md:min-h-[44px] md:flex md:items-center md:justify-center md:right-0.5"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Static Desktop Trigger (Collision-free) */}
            <button
              type="button"
              onClick={handleOpenCreateWizard}
              className="hidden md:flex items-center gap-2 h-11 px-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs lg:text-sm font-bold uppercase tracking-wider shadow-md shadow-emerald-900/20 active:scale-95 transition-[transform,colors] duration-100 motion-reduce:transition-none cursor-pointer whitespace-nowrap shrink-0"
              title="Create Event"
            >
              <Plus className="w-4 h-4 stroke-[2.5]" />
              <span>Create Event</span>
            </button>
          </div>

          {/* Segmented filter tabs */}
          <div className="flex items-center gap-1 bg-stone-200/50 dark:bg-zinc-900 p-1 rounded-xl w-full overflow-x-auto no-scrollbar">
            {(
              [
                { id: 'all', label: 'All', count: statusCounts.all },
                { id: 'active', label: 'Active', count: statusCounts.active },
                { id: 'upcoming', label: 'Upcoming', count: statusCounts.upcoming },
                { id: 'draft', label: 'Draft', count: statusCounts.draft },
                { id: 'ended', label: 'Ended', count: statusCounts.ended },
                { id: 'archived', label: 'Archived', count: statusCounts.archived },
              ] as const
            ).map((tab) => {
              const isSelected = filterStatus === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilterStatus(tab.id)}
                  className={`text-xs sm:text-sm font-medium px-3 py-1.5 md:min-h-[44px] rounded-lg transition-[transform,colors] duration-100 motion-reduce:transition-none flex items-center gap-1.5 whitespace-nowrap active:scale-[0.98] cursor-pointer ${
                    isSelected
                      ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm font-semibold'
                      : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300'
                  }`}
                >
                  <span>{tab.label}</span>
                  <span
                    className={`text-[11px] lg:text-xs px-1.5 py-0.2 rounded-full font-bold ${
                      isSelected
                        ? 'bg-stone-100 dark:bg-zinc-700 text-zinc-900 dark:text-white'
                        : 'bg-stone-200/60 dark:bg-zinc-800 text-zinc-500'
                    }`}
                  >
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {readError && (
          <ReadRetryBanner
            message={readError}
            isRetrying={isRetryingRead}
            onRetry={() => void loadData(true)}
            className="mb-4"
          />
        )}

        {/* ======================================================== */}
        {/* EVENT CARDS LIST (REDESIGNED LAYOUT)                     */}
        {/* ======================================================== */}
        {filteredEvents.length === 0 ? (
          <div className="p-8 text-center bg-white dark:bg-zinc-950 border border-dashed border-stone-200 dark:border-zinc-800 rounded-2xl">
            <Layers className="w-10 h-10 mx-auto text-stone-300 dark:text-zinc-700 mb-3" />
            <h3 className="text-base font-bold text-stone-800 dark:text-white">No Events Found</h3>
            <p className="text-xs sm:text-sm text-stone-500 dark:text-zinc-400 mt-1 max-w-sm mx-auto">
              {searchQuery
                ? 'No events match your search query.'
                : filterStatus === 'archived'
                ? 'No archived events yet. Events you archive will appear here.'
                : 'Get started by creating your first competition event.'}
            </p>
            <button
              type="button"
              onClick={handleOpenCreateWizard}
              className="mt-4 inline-flex items-center gap-2 min-h-[44px] px-5 bg-stone-800 hover:bg-stone-700 text-stone-100 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-100 border border-stone-700/60 rounded-xl text-xs sm:text-sm font-semibold active:scale-[0.98] transition-transform duration-100 motion-reduce:transition-none cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Create Event</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredEvents.map((evt) => {
              const status = (evt.status || 'draft').toLowerCase();
              const scoreCount = scoresMap[evt.id] || 0;
              const hasScores = scoreCount > 0;
              const participantCount = (evt.assigned_participants || []).filter((id) =>
                activeParticipantIdSet.has(id)
              ).length;
              const judgeCount = (evt.assigned_judges || []).filter((id) =>
                activeJudgeIdSet.has(id)
              ).length;

              const isLive = status === 'active';
              const isPaused = status === 'paused';
              const isEnded = status === 'ended' || status === 'archived';

              const hasParticipants = participantCount > 0;
              const hasJudges = judgeCount > 0;
              const isReady = hasParticipants && hasJudges;

              let badgeText = 'DRAFT';
              let badgeClasses = 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20';
              let badgeDotClasses = 'bg-orange-500';

              if (isLive) {
                badgeText = 'ACTIVE';
                badgeClasses = 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20';
                badgeDotClasses = 'bg-emerald-500 animate-pulse motion-reduce:animate-none';
              } else if (isPaused) {
                badgeText = 'PAUSED';
                badgeClasses = 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20';
                badgeDotClasses = 'bg-amber-500';
              } else if (isEnded) {
                badgeText = 'ENDED';
                badgeClasses = 'bg-zinc-500/10 text-zinc-500 dark:text-zinc-400 border border-zinc-500/20';
                badgeDotClasses = 'bg-zinc-400';
              } else if (isReady) {
                badgeText = 'READY';
                badgeClasses = 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20';
                badgeDotClasses = 'bg-sky-500';
              } else {
                badgeText = 'DRAFT';
                badgeClasses = 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20';
                badgeDotClasses = 'bg-orange-500';
              }

              return (
                <div
                  key={evt.id}
                  className="bg-white dark:bg-zinc-950 border border-stone-200/80 dark:border-zinc-800/80 border-t-white/5 rounded-2xl p-4 sm:p-5 shadow-sm hover:border-stone-300 dark:hover:border-zinc-700 transition-colors motion-reduce:transition-none flex flex-col justify-between group"
                >
                  <div>
                    {/* ROW 1: [CATEGORY] pill & Status + Cyan Archived Badge (Left). On Right: [Eye] [Cyan Archive] [Edit] [Delete] */}
                    <div className="flex items-center justify-between gap-2 mb-2.5">
                      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                        <span className="text-xs lg:text-sm font-semibold px-2.5 py-1 rounded-md bg-stone-100 dark:bg-zinc-900 text-stone-600 dark:text-zinc-300 border border-stone-200/50 dark:border-zinc-800/50 truncate max-w-[130px]">
                          {evt.category || 'General'}
                        </span>
                        <span className={`text-[10px] lg:text-xs font-black px-2.5 py-0.5 rounded-full inline-flex items-center gap-1.5 ${badgeClasses}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${badgeDotClasses}`} />
                          {badgeText}
                        </span>
                        {evt.is_locked && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] lg:text-xs font-black uppercase tracking-wider bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/25">
                            <Lock className="w-2.5 h-2.5" />
                            Locked
                          </span>
                        )}
                        {evt.is_archived && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] lg:text-xs font-black uppercase tracking-wider bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/25">
                            <Archive className="w-2.5 h-2.5" />
                            Archived
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {/* Eye Icon to view full event dossier */}
                        <button
                          type="button"
                          onClick={() => setDossierEventId(evt.id)}
                          className="w-8 h-8 md:w-11 md:h-11 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-800 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                          title="View all event details & roster"
                        >
                          <Eye className="w-4 h-4" />
                        </button>

                        {/* Cyan Archive / Restore Icon Button (Inbox Zero - Directive 1) */}
                        <button
                          type="button"
                          onClick={(e) => handleToggleArchive(e, evt)}
                          title={evt.is_archived ? 'Restore from Archive' : 'Archive Event (Inbox Zero)'}
                          className={`w-8 h-8 md:w-11 md:h-11 flex items-center justify-center rounded-lg transition-[transform,colors] duration-100 motion-reduce:transition-none active:scale-95 cursor-pointer ${
                            evt.is_archived
                              ? 'text-cyan-400 bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30'
                              : 'text-stone-400 hover:text-cyan-400 hover:bg-cyan-500/10'
                          }`}
                        >
                          {evt.is_archived ? (
                            <ArchiveRestore className="w-3.5 h-3.5 text-cyan-400" />
                          ) : (
                            <Archive className="w-3.5 h-3.5 text-cyan-500/80 hover:text-cyan-400" />
                          )}
                        </button>

                        {/* Edit Event Icon */}
                        <button
                          type="button"
                          onClick={() => handleEditClick(evt)}
                          title={
                            status === 'active'
                              ? 'Prohibited: Event is live'
                              : status === 'ended' || status === 'archived'
                              ? 'Prohibited: Event has ended'
                              : 'Edit Event'
                          }
                          className={`w-8 h-8 md:w-11 md:h-11 flex items-center justify-center rounded-lg active:scale-95 transition-[transform,colors] duration-100 motion-reduce:transition-none cursor-pointer ${
                            status === 'active' || status === 'ended' || status === 'archived'
                              ? 'text-zinc-300 dark:text-zinc-700 cursor-not-allowed'
                              : 'text-stone-600 hover:text-stone-900 dark:text-zinc-300 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-zinc-800'
                          }`}
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>

                        {/* Delete Event Icon (Tiered Deletion Matrix - Directive 1) */}
                        <button
                          type="button"
                          onClick={(e) => handleDeleteClick(e, evt)}
                          title={
                            status === 'active'
                              ? 'Action Denied: Cannot delete an active event'
                              : isEnded
                              ? 'Delete Ended Event (Master Password Required)'
                              : 'Delete Event'
                          }
                          className={`w-8 h-8 md:w-11 md:h-11 flex items-center justify-center rounded-lg transition-[transform,colors] duration-100 motion-reduce:transition-none ${
                            status === 'active'
                              ? 'opacity-50 cursor-not-allowed text-stone-400 dark:text-zinc-400 hover:bg-transparent'
                              : 'text-stone-400 hover:text-red-500 hover:bg-red-500/10 active:scale-95 cursor-pointer'
                          }`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* ROW 2: Massive, bold Event Name */}
                    <h3 className="text-lg sm:text-xl font-black text-stone-900 dark:text-white leading-snug tracking-tight">
                      {evt.name}
                    </h3>
                  </div>

                  {/* BOTTOM ROW: Smart assignment buttons */}
                  <div className="mt-4 pt-3 border-t border-stone-100 dark:border-zinc-800/80 flex items-center justify-between gap-2">
                    {/* Participants Button */}
                    {!evt.is_locked && !hasParticipants && !isLive && !isEnded && !isPaused ? (
                      <button
                        type="button"
                        onClick={() => {
                          setActiveParticipantsEventId(evt.id);
                          setParticipantSearch('');
                          setParticipantViewMode('lineup');
                          setParticipantPickerSearch('');
                          setSelectedPickerParticipantIds([]);
                          setIsParticipantPickerOpen(true);
                        }}
                        className="min-h-[38px] md:min-h-[44px] px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs lg:text-sm font-bold border border-indigo-600 flex items-center gap-1.5 transition-transform duration-100 motion-reduce:transition-none active:scale-95 cursor-pointer shadow-xs"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        <span>Add Participants</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setActiveParticipantsEventId(evt.id);
                          setParticipantSearch('');
                          setParticipantViewMode('lineup');
                          setParticipantPickerSearch('');
                          setSelectedPickerParticipantIds([]);
                          setIsParticipantPickerOpen(false);
                        }}
                        className="min-h-[38px] md:min-h-[44px] px-3.5 py-1.5 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-850 text-stone-800 dark:text-zinc-200 text-xs lg:text-sm font-bold border border-stone-200/80 dark:border-zinc-800 flex items-center gap-2 transition-transform duration-100 motion-reduce:transition-none active:scale-95 cursor-pointer shadow-xs"
                      >
                        <Users className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                        <span className="tabular-nums">Participants {String(participantCount).padStart(2, '0')}</span>
                      </button>
                    )}

                    {/* Judges Button */}
                    {!evt.is_locked && !hasJudges && !isLive && !isEnded && !isPaused ? (
                      <button
                        type="button"
                        onClick={() => {
                          setActiveJudgesEventId(evt.id);
                          setJudgeSearch('');
                          setJudgePickerSearch('');
                          setSelectedPickerJudgeIds([]);
                          setIsJudgePickerOpen(true);
                        }}
                        className="min-h-[38px] md:min-h-[44px] px-3.5 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-xs lg:text-sm font-bold border border-amber-500 flex items-center gap-1.5 transition-transform duration-100 motion-reduce:transition-none active:scale-95 cursor-pointer shadow-xs"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add Judges</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setActiveJudgesEventId(evt.id);
                          setJudgeSearch('');
                          setJudgePickerSearch('');
                          setSelectedPickerJudgeIds([]);
                          setIsJudgePickerOpen(false);
                        }}
                        className="min-h-[38px] md:min-h-[44px] px-3.5 py-1.5 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-850 text-stone-800 dark:text-zinc-200 text-xs lg:text-sm font-bold border border-stone-200/80 dark:border-zinc-800 flex items-center gap-2 transition-transform duration-100 motion-reduce:transition-none active:scale-95 cursor-pointer shadow-xs"
                      >
                        <Gavel className="w-3.5 h-3.5 text-amber-500" />
                        <span className="tabular-nums">Judges {String(judgeCount).padStart(2, '0')}</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ======================================================== */}
      {/* FULL-SCREEN CREATE / EDIT EVENT PAGE (TaskScreen)        */}
      {/* ======================================================== */}
      <TaskScreen
        isOpen={isWizardOpen}
        title={editingEventId ? 'Edit Event' : 'New Event'}
        onBack={handleCloseWizard}
        hasNestedOverlay={Boolean(isUnsavedExitModalOpen || isEventActionModalOpen)}
        maxWidthClass="md:max-w-2xl lg:max-w-[1000px]"
        headerAction={
          <button
            type="button"
            disabled={!isFormValid || isSubmitting}
            onClick={handleSaveEvent}
            className="min-h-[44px] px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs sm:text-sm font-bold shadow-md shadow-emerald-600/20 active:scale-[0.98] transition-[transform,opacity] duration-100 motion-reduce:transition-none disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-1.5"
          >
            <Check className="w-4 h-4 stroke-[2.5]" />
            <span>{isSubmitting ? 'Saving...' : 'Save'}</span>
          </button>
        }
        footer={
          <div className="w-full flex items-center justify-center text-center">
            <div className="text-xs sm:text-sm font-semibold text-stone-700 dark:text-zinc-300 flex items-center justify-center gap-1.5">
              <span>Total Marks:</span>
              <span className="font-mono font-black text-emerald-600 dark:text-emerald-400 text-sm sm:text-base tabular-nums whitespace-nowrap">
                {totalRubricMarks} pts
              </span>
            </div>
          </div>
        }
      >
        {eventMissingReason && (
          <p className="-mx-4 -mt-5 px-4 py-1.5 border-b border-stone-200/70 dark:border-zinc-800/70 bg-stone-100/70 dark:bg-zinc-950/70 text-[13px] font-medium text-zinc-500 dark:text-zinc-400 text-center">
            {eventMissingReason}
          </p>
        )}

        <div className="max-w-2xl lg:max-w-[1000px] w-full mx-auto space-y-5">
          {/* Draft Recovery Banner */}
          {showDraftBanner && cachedDraft && !editingEventId && (
            <div className="p-3 bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 text-emerald-800 dark:text-emerald-300 rounded-2xl text-xs sm:text-sm font-medium flex flex-wrap items-center justify-between gap-2 animate-in fade-in motion-reduce:animate-none">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span>
                  Unsaved draft found for &quot;<strong>{cachedDraft.name || 'Untitled Event'}</strong>&quot;.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleResumeDraft}
                  className="min-h-[44px] px-3 inline-flex items-center bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs lg:text-sm font-bold active:scale-95 transition-transform duration-100 motion-reduce:transition-none cursor-pointer"
                >
                  Resume Draft
                </button>
                <button
                  type="button"
                  onClick={handleDiscardDraft}
                  className="min-h-[44px] px-3 inline-flex items-center bg-stone-200/80 dark:bg-zinc-800 hover:bg-stone-300 text-stone-700 dark:text-zinc-300 rounded-xl text-xs lg:text-sm font-semibold active:scale-95 transition-transform duration-100 motion-reduce:transition-none cursor-pointer"
                >
                  Start Fresh
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-stretch">
            {/* PANEL 1: EVENT DETAILS */}
            <section className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl shadow-sm p-3 sm:p-5 flex flex-col gap-4 min-w-0">
              <EventFormPanelHeader
                step={1}
                title="Event details"
                summary={eventName.trim() ? eventCategory.trim() || 'General' : 'Title and category'}
                isComplete={Boolean(eventName.trim())}
              />

              {/* Event Title */}
              <div>
                <label
                  htmlFor="event-title-input"
                  className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5 block"
                >
                  Event Title <span className="text-emerald-600 dark:text-emerald-400">*</span>
                </label>
                <input
                  id="event-title-input"
                  ref={eventTitleInputRef}
                  type="text"
                  placeholder="e.g. Classical Solo Dance"
                  value={eventName}
                  enterKeyHint="next"
                  onChange={(e) => {
                    setIsDirty(true);
                    setEventName(e.target.value);
                  }}
                  onBlur={() => setEventTitleTouched(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      eventCategoryInputRef.current?.focus();
                    }
                  }}
                  className={`w-full h-12 px-3.5 rounded-xl bg-stone-50 dark:bg-zinc-900 border text-sm sm:text-base font-semibold text-stone-900 dark:text-white focus:outline-none focus:ring-2 transition-colors ${
                    eventTitleTouched && !eventName.trim()
                      ? 'border-rose-500 focus:ring-rose-500/30'
                      : 'border-stone-200 dark:border-zinc-800 focus:ring-emerald-500/40'
                  }`}
                />
                {eventTitleTouched && !eventName.trim() && (
                  <p className="text-xs font-medium text-rose-600 dark:text-rose-400 mt-1.5">
                    Event Title is required.
                  </p>
                )}
              </div>

              {/* Category (Input + Sleek Emerald Chips + Reset) */}
              <div>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <label
                    htmlFor="event-category-input"
                    className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
                  >
                    Category
                  </label>
                  {!categorySuggested &&
                    defaultSuggestedCategory &&
                    eventCategory.trim() !== defaultSuggestedCategory && (
                      <button
                        type="button"
                        onClick={() => {
                          setIsDirty(true);
                          setEventCategory(defaultSuggestedCategory);
                          setCategorySuggested(true);
                        }}
                        className="min-h-[44px] -my-2 inline-flex items-center text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:underline cursor-pointer"
                      >
                        Reset to suggested
                      </button>
                    )}
                </div>

                <input
                  id="event-category-input"
                  ref={eventCategoryInputRef}
                  type="text"
                  placeholder="e.g. Senior, Junior, Classical"
                  value={eventCategory}
                  enterKeyHint={rubricCriteria.length > 0 && !hasExistingScores ? 'next' : 'done'}
                  onChange={(e) => {
                    setIsDirty(true);
                    setCategorySuggested(false);
                    setEventCategory(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const firstId = rubricCriteria[0]?.id;
                      if (firstId && !hasExistingScores) {
                        criterionNameRefs.current[firstId]?.focus();
                      } else {
                        e.currentTarget.blur();
                      }
                    }
                  }}
                  className="w-full h-12 bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl px-3.5 text-stone-900 dark:text-white text-sm font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/40 placeholder:text-stone-400 dark:placeholder:text-zinc-400 transition-colors motion-reduce:transition-none"
                />

                {/* Tappable Category Chips: Single horizontal row, h-7 text-[11px] inside 44px tap area */}
                <div className="flex items-center flex-nowrap gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 mt-1">
                  {categoryChips.map((chip) => {
                    const isActive = eventCategory.trim().toLowerCase() === chip.toLowerCase();
                    return (
                      <button
                        key={chip}
                        type="button"
                        onClick={() => {
                          setIsDirty(true);
                          setEventCategory(chip);
                          setCategorySuggested(chip === defaultSuggestedCategory && !editingEventId);
                        }}
                        className="min-h-[44px] py-2 shrink-0 inline-flex items-center cursor-pointer group focus:outline-none"
                      >
                        <span
                          className={`h-7 px-2.5 rounded-lg inline-flex items-center whitespace-nowrap text-[11px] font-semibold border transition-colors ${
                            isActive
                              ? 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-200 border-emerald-500/50'
                              : 'bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300 border-emerald-500/20 group-hover:bg-emerald-500/[0.14] group-hover:border-emerald-500/35'
                          }`}
                        >
                          {chip}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            {/* PANEL 2: RUBRIC */}
            <section className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl shadow-sm p-3 sm:p-5 flex flex-col gap-4 min-w-0">
              <EventFormPanelHeader
                step={2}
                title="Rubric"
                isComplete={hasValidCriterion}
              />

              {/* Quick Templates: Sleek soft emerald tint */}
              {!hasExistingScores && (
                <div>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 block mb-0.5">
                    Quick templates
                  </span>
                  <div className="flex items-center flex-nowrap gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1">
                    {RUBRIC_PRESETS.map((preset) => {
                      const isPresetActive =
                        preset.criteria.length === rubricCriteria.length &&
                        preset.criteria.every(
                          (pc, idx) =>
                            rubricCriteria[idx]?.name.trim() === pc.name &&
                            Number(rubricCriteria[idx]?.maxMarks) === pc.maxMarks
                        );
                      return (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() => handleApplyPreset(preset)}
                          className="min-h-[44px] py-2 shrink-0 inline-flex items-center cursor-pointer group focus:outline-none"
                        >
                          <span
                            className={`h-7 px-2.5 rounded-lg inline-flex items-center whitespace-nowrap border text-[11px] font-semibold transition-colors ${
                              isPresetActive
                                ? 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-200 border-emerald-500/50'
                                : 'bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300 border-emerald-500/20 group-hover:bg-emerald-500/[0.14] group-hover:border-emerald-500/35'
                            }`}
                          >
                            {preset.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {rubricTouched && !hasValidCriterion && (
                <p className="text-xs font-medium text-rose-600 dark:text-rose-400">
                  Add a name for at least one rubric criterion.
                </p>
              )}

              {/* Single Container for All Criteria Rows */}
              <div className="bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl divide-y divide-stone-200 dark:divide-zinc-800 overflow-hidden">
                {/* Column Header Row (MARKS label once per list) */}
                <div className="flex items-center gap-1.5 px-2 py-1.5 bg-stone-100/70 dark:bg-zinc-900/80">
                  <span className="w-6 shrink-0" />
                  <span className="flex-1 min-w-0 text-[10px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 px-1.5">
                    Criterion
                  </span>
                  <span className="w-14 shrink-0 text-center text-[10px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                    MARKS
                  </span>
                  {!hasExistingScores && <span className="w-11 shrink-0" />}
                </div>

                {rubricCriteria.map((item, index) => {
                  const isLastCriterion = index === rubricCriteria.length - 1;
                  const isDragging = draggingCriterionId === item.id;
                  const canReorder = !hasExistingScores && rubricCriteria.length > 1;
                  return (
                    <div
                      key={item.id}
                      ref={(el) => {
                        criterionRowRefs.current[item.id] = el;
                      }}
                      onPointerDown={(e) => handleCriterionPointerDown(item.id, e)}
                      onKeyDown={(e) => {
                        if (!hasExistingScores && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                          e.preventDefault();
                          handleMoveCriterion(index, e.key === 'ArrowUp' ? -1 : 1);
                        }
                      }}
                      className={`min-h-[56px] flex items-center gap-1.5 px-2 py-2 ${
                        isDragging
                          ? 'bg-emerald-50/80 dark:bg-emerald-500/15 ring-1 ring-emerald-500/40 relative z-10'
                          : 'transition-colors motion-reduce:transition-none'
                      }`}
                    >
                      {/* Index / Drag Handle (24px wide, >=44px tall, touch-none) */}
                      <span
                        data-criterion-handle="true"
                        tabIndex={canReorder ? 0 : undefined}
                        role={canReorder ? 'button' : undefined}
                        aria-label={
                          canReorder
                            ? `Criterion ${index + 1}, hold to drag or press Alt+Up/Down to reorder`
                            : undefined
                        }
                        className={`w-6 min-h-[44px] shrink-0 flex items-center justify-center text-xs font-bold font-mono text-zinc-400 select-none tabular-nums focus:outline-none focus:text-emerald-600 dark:focus:text-emerald-400 ${
                          canReorder ? 'touch-none cursor-grab active:cursor-grabbing' : ''
                        }`}
                      >
                        {index + 1}.
                      </span>

                      {/* Name Textarea (flex-1, min-w-0, auto-grows up to 2+ lines, zero clipping) */}
                      <textarea
                        ref={(el) => {
                          criterionNameRefs.current[item.id] = el;
                          syncCriterionTextareaHeight(el);
                        }}
                        rows={1}
                        placeholder="Criterion name"
                        value={item.name}
                        disabled={hasExistingScores}
                        enterKeyHint="next"
                        onChange={(e) => {
                          syncCriterionTextareaHeight(e.currentTarget);
                          handleUpdateCriterion(item.id, 'name', e.target.value);
                        }}
                        onBlur={() => setRubricTouched(true)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            criterionMarksRefs.current[item.id]?.focus();
                          }
                        }}
                        className="flex-1 min-w-0 resize-none overflow-hidden py-1.5 px-1.5 rounded-xl bg-transparent border-none outline-none focus:outline-none focus:ring-0 text-sm font-semibold leading-5 text-stone-900 dark:text-white placeholder:text-stone-400 dark:placeholder:text-zinc-500 disabled:opacity-60"
                      />

                      {/* Marks Field (w-14, number only, no "pts") */}
                      <input
                        ref={(el) => {
                          criterionMarksRefs.current[item.id] = el;
                        }}
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={editingMarksText[item.id] ?? String(item.maxMarks)}
                        disabled={hasExistingScores}
                        aria-label={`Max marks for criterion ${index + 1}`}
                        enterKeyHint={isLastCriterion && hasExistingScores ? 'done' : 'next'}
                        onChange={(e) => {
                          const raw = e.target.value.replace(/\D/g, '').slice(0, 3);
                          setEditingMarksText((prev) => ({ ...prev, [item.id]: raw }));
                          if (raw !== '') {
                            const parsed = parseInt(raw, 10);
                            const clamped = Math.min(100, Math.max(1, parsed));
                            handleUpdateCriterion(item.id, 'maxMarks', clamped);
                          }
                        }}
                        onBlur={() => {
                          setEditingMarksText((prev) => {
                            if (!(item.id in prev)) return prev;
                            const next = { ...prev };
                            delete next[item.id];
                            return next;
                          });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            if (!isLastCriterion) {
                              const nextId = rubricCriteria[index + 1]?.id;
                              if (nextId) criterionNameRefs.current[nextId]?.focus();
                            } else if (!hasExistingScores) {
                              handleAddCriterion(true);
                            } else {
                              e.currentTarget.blur();
                            }
                          }
                        }}
                        className="w-14 shrink-0 h-11 px-2 text-center font-mono font-bold tabular-nums rounded-xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 text-xs sm:text-sm text-stone-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40 disabled:opacity-60"
                      />

                      {/* Single Minus Button (44x44) — Hidden when hasExistingScores */}
                      {!hasExistingScores && (
                        <button
                          type="button"
                          disabled={rubricCriteria.length <= 1}
                          aria-label={`Remove criterion ${index + 1}`}
                          onClick={() => handleRemoveCriterion(item.id)}
                          className="w-11 h-11 shrink-0 rounded-xl flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-500/10 active:scale-95 transition-[transform,colors] duration-100 motion-reduce:transition-none disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                        >
                          <Minus className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {!hasExistingScores && (
                <button
                  type="button"
                  onClick={() => handleAddCriterion(true)}
                  className="w-full min-h-[44px] border border-dashed border-stone-300 dark:border-zinc-800 hover:border-emerald-500 dark:hover:border-emerald-500 rounded-xl text-xs sm:text-sm font-bold text-zinc-600 dark:text-zinc-300 hover:text-emerald-600 dark:hover:text-emerald-400 transition-[transform,colors] duration-100 motion-reduce:transition-none flex items-center justify-center gap-2 cursor-pointer active:scale-[0.99] bg-stone-50/50 dark:bg-zinc-900"
                >
                  <Plus className="w-4 h-4 stroke-[2.2]" />
                  <span>Add Criterion</span>
                </button>
              )}
            </section>
          </div>
        </div>
      </TaskScreen>

      <UnsavedChangesDialog
        isOpen={isUnsavedExitModalOpen}
        dialogRef={unsavedExitDialogRef}
        canSaveDraft={!editingEventId}
        onSaveDraft={handleSaveDraftAndExit}
        onDiscardAndExit={handleForceDiscardAndExit}
        onKeepEditing={() => setIsUnsavedExitModalOpen(false)}
      />

      {/* ======================================================== */}
      {/* FULL-SCREEN PARTICIPANTS LINEUP (TaskScreen)             */}
      {/* ======================================================== */}
      <TaskScreen
        isOpen={Boolean(activeParticipantsModalEvent)}
        title={activeParticipantsModalEvent?.name || ''}
        subtitle="Participant roster & appearance sequence"
        onBack={handleCloseParticipantsModal}
        hasNestedOverlay={Boolean(isEventActionModalOpen || isParticipantPickerOpen)}
        maxWidthClass="md:max-w-2xl"
        primaryAction={{
          label: 'Done',
          onClick: handleCloseParticipantsModal,
          variant: 'neutral',
        }}
      >
        {activeParticipantsModalEvent &&
          (() => {
            const eventStatus = (activeParticipantsModalEvent.status || 'draft').toLowerCase();
            const isLocked = Boolean(activeParticipantsModalEvent.is_locked);
            const canAddParticipants =
              !isLocked && eventStatus !== 'ended' && eventStatus !== 'archived';
            const isReorderLocked =
              isLocked ||
              eventStatus === 'active' ||
              eventStatus === 'ended' ||
              eventStatus === 'archived';

            const assignedIds = (activeParticipantsModalEvent.assigned_participants || []).filter(
              (id) => activeParticipantIdSet.has(id)
            );
            const activeParticipantMap = new Map(
              participants
                .filter((p) => p.is_active !== false)
                .map((p) => [p.id, p])
            );
            const enrolledList = assignedIds
              .map((id) => activeParticipantMap.get(id))
              .filter((p): p is SupabaseParticipant => Boolean(p));

            const isFiltering = participantSearch.trim() !== '';
            const searchLower = participantSearch.toLowerCase();
            const filteredEnrolled = enrolledList.filter(
              (p) =>
                !isFiltering ||
                p.name.toLowerCase().includes(searchLower) ||
                (p.identity_id && p.identity_id.toLowerCase().includes(searchLower)) ||
                (p.school && p.school.toLowerCase().includes(searchLower))
            );

            return (
              <div className="max-w-2xl w-full mx-auto space-y-4">
                {/* Event Status Banner */}
                {isLocked ? (
                  <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 text-amber-800 dark:text-amber-300 text-xs lg:text-sm font-medium flex items-center gap-2">
                    <Lock className="w-4 h-4 text-amber-500 shrink-0" />
                    <span>
                      Roster Locked: This event&apos;s roster is frozen. Participants and performance order cannot be changed.
                    </span>
                  </div>
                ) : eventStatus === 'active' ? (
                  <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 text-emerald-800 dark:text-emerald-300 text-xs lg:text-sm font-medium flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>
                      Event is Live: You can add new participants while the competition continues. Removals and order changes are locked.
                    </span>
                  </div>
                ) : eventStatus === 'ended' || eventStatus === 'archived' ? (
                  <div className="p-3 rounded-xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 text-xs lg:text-sm font-medium flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-zinc-500 shrink-0" />
                    <span>
                      Event is Ended: Roster is permanently sealed. No participants can be added or removed.
                    </span>
                  </div>
                ) : null}

                {/* Single Primary Action + Participants-Only Running Order Toggle */}
                <div className="flex flex-wrap items-center justify-between gap-2.5">
                  <div className="flex items-center gap-3">
                    {canAddParticipants && (
                      <button
                        type="button"
                        onClick={() => {
                          setParticipantPickerSearch('');
                          setSelectedPickerParticipantIds([]);
                          setIsParticipantPickerOpen(true);
                        }}
                        className="min-h-[44px] px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs lg:text-sm font-bold flex items-center gap-2 active:scale-[0.98] transition-[transform,colors] duration-100 motion-reduce:transition-none shadow-xs cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <UserPlus className="w-4 h-4 shrink-0" />
                        <span>Add participants</span>
                      </button>
                    )}
                    <span className="text-xs lg:text-sm font-semibold text-zinc-500 dark:text-zinc-400 tabular-nums">
                      {enrolledList.length} {enrolledList.length === 1 ? 'participant' : 'participants'}
                    </span>
                  </div>

                  {enrolledList.length > 0 && (
                    <div
                      role="tablist"
                      aria-label="Participant view mode"
                      className="flex items-center gap-1 p-1 bg-stone-200/70 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl"
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={participantViewMode === 'lineup'}
                        onClick={() => setParticipantViewMode('lineup')}
                        className={`min-h-[36px] px-3 rounded-lg text-xs font-bold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                          participantViewMode === 'lineup'
                            ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-xs'
                            : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                        }`}
                      >
                        Roster
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={participantViewMode === 'order'}
                        onClick={() => setParticipantViewMode('order')}
                        className={`min-h-[36px] px-3 rounded-lg text-xs font-bold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                          participantViewMode === 'order'
                            ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-xs'
                            : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                        }`}
                      >
                        Running Order
                      </button>
                    </div>
                  )}
                </div>

                {/* Empty Roster */}
                {enrolledList.length === 0 ? (
                  <div className="p-8 text-center bg-white dark:bg-zinc-900 border border-dashed border-stone-200 dark:border-zinc-800 rounded-2xl shadow-sm space-y-2">
                    <Users className="w-8 h-8 mx-auto text-zinc-300 dark:text-zinc-700" />
                    <h4 className="text-sm font-bold text-zinc-800 dark:text-white">
                      No Participants Enrolled
                    </h4>
                    <p className="text-xs lg:text-sm text-zinc-500">
                      {canAddParticipants
                        ? 'Use "Add participants" above to select competitors from your organization.'
                        : 'No competitors are enrolled in this event.'}
                    </p>
                  </div>
                ) : participantViewMode === 'order' ? (
                  /* RUNNING ORDER VIEW (Participants Only — Up/Down Buttons Only) */
                  <div className="space-y-2.5">
                    {isReorderLocked ? (
                      <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs lg:text-sm font-semibold">
                        <Lock className="w-4 h-4 shrink-0" />
                        <span>
                          Performance order is locked while the event is live, ended, or frozen.
                        </span>
                      </div>
                    ) : (
                      <p className="text-xs lg:text-sm text-zinc-500 dark:text-zinc-400 px-0.5">
                        Use the Up and Down buttons to adjust performance order.
                      </p>
                    )}

                    <div className="space-y-2">
                      {enrolledList.map((p, idx) => {
                        const orderSerial =
                          activeParticipantsModalEvent.participant_sl_numbers?.[p.id] ||
                          String(idx + 1).padStart(2, '0');
                        return (
                          <div
                            key={p.id}
                            className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-3 flex items-center justify-between gap-3 shadow-xs"
                          >
                            <div className="flex items-center gap-3 min-w-0 flex-1">
                              <div className="w-10 h-10 rounded-xl bg-indigo-500/10 dark:bg-indigo-500/15 border border-indigo-500/20 flex items-center justify-center font-mono font-bold text-xs lg:text-sm text-indigo-700 dark:text-indigo-300 tabular-nums shrink-0">
                                #{orderSerial}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-bold text-zinc-900 dark:text-white truncate">
                                  {p.name}
                                </div>
                                <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] lg:text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                                  <span className="font-mono tabular-nums">
                                    {p.identity_id || `P-${p.sl_no || '0000'}`}
                                  </span>
                                  <span aria-hidden="true">·</span>
                                  <span className="truncate">{p.school || 'General Institution'}</span>
                                </div>
                              </div>
                            </div>

                            {!isReorderLocked && (
                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  type="button"
                                  disabled={idx === 0}
                                  onClick={() => handleReorderParticipant(idx, idx - 1)}
                                  title="Move earlier in lineup"
                                  aria-label={`Move ${p.name} up`}
                                  className="min-w-[44px] min-h-[44px] rounded-xl border border-stone-200 dark:border-zinc-800 bg-stone-50 dark:bg-zinc-950 flex items-center justify-center text-zinc-700 dark:text-zinc-200 hover:bg-stone-100 dark:hover:bg-zinc-800 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-[transform,colors] duration-100 motion-reduce:transition-none"
                                >
                                  <ChevronUp className="w-4 h-4" />
                                </button>
                                <button
                                  type="button"
                                  disabled={idx === enrolledList.length - 1}
                                  onClick={() => handleReorderParticipant(idx, idx + 1)}
                                  title="Move later in lineup"
                                  aria-label={`Move ${p.name} down`}
                                  className="min-w-[44px] min-h-[44px] rounded-xl border border-stone-200 dark:border-zinc-800 bg-stone-50 dark:bg-zinc-950 flex items-center justify-center text-zinc-700 dark:text-zinc-200 hover:bg-stone-100 dark:hover:bg-zinc-800 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-[transform,colors] duration-100 motion-reduce:transition-none"
                                >
                                  <ChevronDown className="w-4 h-4" />
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  /* ROSTER VIEW */
                  <div className="space-y-3">
                    <div className="relative">
                      <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        placeholder="Search enrolled participants by name, ID, or school..."
                        value={participantSearch}
                        onChange={(e) => setParticipantSearch(e.target.value)}
                        className="w-full min-h-[44px] pl-9 pr-3 text-xs lg:text-sm bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-xl text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                      />
                    </div>

                    {filteredEnrolled.length === 0 ? (
                      <div className="p-6 text-center text-xs lg:text-sm text-zinc-500">
                        No enrolled participants match your search.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {filteredEnrolled.map((p) => {
                          const originalIdx = enrolledList.findIndex((item) => item.id === p.id);
                          const orderSerial =
                            activeParticipantsModalEvent.participant_sl_numbers?.[p.id] ||
                            String(originalIdx + 1).padStart(2, '0');
                          return (
                            <div
                              key={p.id}
                              className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 shadow-xs rounded-2xl p-3.5 flex items-center justify-between gap-2.5"
                            >
                              <div className="flex items-center gap-3 min-w-0 flex-1">
                                <div className="w-9 h-9 rounded-xl bg-stone-100 dark:bg-zinc-800 border border-stone-200 dark:border-zinc-700/80 flex items-center justify-center font-mono font-bold text-xs lg:text-sm text-zinc-800 dark:text-zinc-200 tabular-nums shrink-0">
                                  #{orderSerial}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="text-sm font-bold text-zinc-900 dark:text-white truncate">
                                    {p.name}
                                  </div>
                                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] lg:text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">
                                    <span className="font-mono tabular-nums">
                                      {p.identity_id || `P-${p.sl_no || '0000'}`}
                                    </span>
                                    <span aria-hidden="true">·</span>
                                    <span>{p.school || 'General Institution'}</span>
                                    {p.class_or_age && (
                                      <>
                                        <span aria-hidden="true">·</span>
                                        <span>{p.class_or_age}</span>
                                      </>
                                    )}
                                  </div>
                                </div>
                              </div>

                              {!isLocked && (
                                <button
                                  type="button"
                                  onClick={() => handleRemoveParticipantFromEvent(p.id)}
                                  title="Remove from this event"
                                  aria-label={`Remove ${p.name} from event`}
                                  className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-zinc-400 hover:text-red-500 hover:bg-red-500/10 active:scale-95 transition-[transform,colors] duration-100 motion-reduce:transition-none cursor-pointer shrink-0"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
      </TaskScreen>

      {/* ======================================================== */}
      {/* PARTICIPANTS PICKER (TaskScreen — Two-Pane on Laptop)    */}
      {/* ======================================================== */}
      <TaskScreen
        isOpen={Boolean(activeParticipantsModalEvent && isParticipantPickerOpen)}
        title="Add Participants"
        subtitle={activeParticipantsModalEvent?.name || ''}
        onBack={handleCloseParticipantPicker}
        maxWidthClass="md:max-w-2xl lg:max-w-5xl"
        secondaryAction={{
          label: 'Cancel',
          onClick: handleCloseParticipantPicker,
          disabled: isBatchEnrolling,
        }}
        primaryAction={{
          label:
            selectedPickerParticipantIds.length > 0
              ? `Add ${selectedPickerParticipantIds.length} ${
                  selectedPickerParticipantIds.length === 1 ? 'participant' : 'participants'
                }`
              : 'Add participants',
          loading: isBatchEnrolling,
          loadingLabel: 'Adding...',
          disabled:
            isBatchEnrolling ||
            selectedPickerParticipantIds.length === 0 ||
            !activeParticipantsModalEvent ||
            Boolean(activeParticipantsModalEvent.is_locked) ||
            (activeParticipantsModalEvent.status || 'draft').toLowerCase() === 'ended' ||
            (activeParticipantsModalEvent.status || 'draft').toLowerCase() === 'archived',
          onClick: () => void handleBatchEnrollParticipantsToEvent(selectedPickerParticipantIds),
          variant: 'indigo',
        }}
        footer={
          <span className="text-xs lg:text-sm font-semibold text-zinc-600 dark:text-zinc-300 tabular-nums">
            {selectedPickerParticipantIds.length > 0
              ? `${selectedPickerParticipantIds.length} selected`
              : 'Select participants to add'}
          </span>
        }
      >
        {activeParticipantsModalEvent &&
          (() => {
            const eventStatus = (activeParticipantsModalEvent.status || 'draft').toLowerCase();
            const canAddParticipants =
              !activeParticipantsModalEvent.is_locked &&
              eventStatus !== 'ended' &&
              eventStatus !== 'archived';

            const assignedSet = new Set(activeParticipantsModalEvent.assigned_participants || []);
            const availableParticipants = participants.filter(
              (p) => p.is_active !== false && !assignedSet.has(p.id)
            );
            const q = participantPickerSearch.trim().toLowerCase();
            const filteredAvailable = availableParticipants.filter(
              (p) =>
                !q ||
                p.name.toLowerCase().includes(q) ||
                (p.identity_id && p.identity_id.toLowerCase().includes(q)) ||
                (p.school && p.school.toLowerCase().includes(q)) ||
                (p.class_or_age && p.class_or_age.toLowerCase().includes(q))
            );

            const selectedSet = new Set(selectedPickerParticipantIds);
            const selectedItems = availableParticipants.filter((p) => selectedSet.has(p.id));
            const eligibleFilteredIds = canAddParticipants ? filteredAvailable.map((p) => p.id) : [];

            const handleToggleParticipantPick = (id: string) => {
              if (!canAddParticipants) return;
              setSelectedPickerParticipantIds((prev) =>
                prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
              );
            };

            const handleSelectAllFilteredParticipants = () => {
              if (!canAddParticipants || eligibleFilteredIds.length === 0) return;
              setSelectedPickerParticipantIds((prev) => {
                const next = new Set(prev);
                eligibleFilteredIds.forEach((id) => next.add(id));
                return Array.from(next);
              });
            };

            return (
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-5 items-start">
                {/* Left Pane (or Full Screen on Phone): Search + Toolbar + Roster Checklist */}
                <div className="space-y-3 min-w-0">
                  {!canAddParticipants && (
                    <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 text-amber-800 dark:text-amber-300 text-xs lg:text-sm font-medium flex items-center gap-2">
                      <Lock className="w-4 h-4 shrink-0" />
                      <span>
                        Adding participants is blocked while this event is locked or ended.
                      </span>
                    </div>
                  )}

                  <div className="relative">
                    <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      placeholder="Search unassigned participants by name, ID, or school..."
                      value={participantPickerSearch}
                      onChange={(e) => setParticipantPickerSearch(e.target.value)}
                      className="w-full min-h-[44px] pl-9 pr-3 text-xs lg:text-sm bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-xl text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={!canAddParticipants || eligibleFilteredIds.length === 0}
                        onClick={handleSelectAllFilteredParticipants}
                        className="min-h-[40px] px-3 rounded-xl border border-stone-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs font-bold text-zinc-800 dark:text-zinc-200 hover:bg-stone-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors whitespace-nowrap shrink-0"
                      >
                        Select all
                      </button>
                      {selectedPickerParticipantIds.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSelectedPickerParticipantIds([])}
                          className="min-h-[40px] px-3 rounded-xl text-xs font-semibold text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white cursor-pointer whitespace-nowrap shrink-0"
                        >
                          Clear
                        </button>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => handleCreateNewFromPicker('participant')}
                      className="min-h-[40px] px-3 rounded-xl border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/70 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-500/20 text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap shrink-0"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Create new</span>
                    </button>
                  </div>

                  {availableParticipants.length === 0 ? (
                    <div className="p-8 text-center bg-white dark:bg-zinc-900 border border-dashed border-stone-200 dark:border-zinc-800 rounded-2xl space-y-3">
                      <Users className="w-8 h-8 mx-auto text-zinc-300 dark:text-zinc-700" />
                      <div className="space-y-1">
                        <h4 className="text-sm font-bold text-zinc-900 dark:text-white">
                          No Unassigned Participants
                        </h4>
                        <p className="text-xs lg:text-sm text-zinc-500">
                          All active participants in your organization are already enrolled in this event.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleCreateNewFromPicker('participant')}
                        className="min-h-[44px] px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs lg:text-sm font-bold inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <Plus className="w-4 h-4" />
                        <span>Create new participant</span>
                      </button>
                    </div>
                  ) : filteredAvailable.length === 0 ? (
                    <div className="p-6 text-center bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl space-y-2">
                      <p className="text-xs lg:text-sm text-zinc-500">
                        No unassigned participants match &quot;{participantPickerSearch}&quot;.
                      </p>
                      <button
                        type="button"
                        onClick={() => handleCreateNewFromPicker('participant')}
                        className="min-h-[40px] px-3 rounded-xl text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                      >
                        Create new participant in People tab
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {filteredAvailable.map((p) => {
                        const isSelected = selectedSet.has(p.id);
                        return (
                          <button
                            key={p.id}
                            type="button"
                            disabled={!canAddParticipants}
                            aria-pressed={isSelected}
                            onClick={() => handleToggleParticipantPick(p.id)}
                            className={`w-full min-h-[58px] text-left p-3.5 rounded-2xl border flex items-center gap-3 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                              isSelected
                                ? 'bg-indigo-50/70 dark:bg-indigo-950/30 border-indigo-400 dark:border-indigo-500/60'
                                : 'bg-white dark:bg-zinc-900 border-stone-200 dark:border-zinc-800 hover:border-stone-300 dark:hover:border-zinc-700'
                            }`}
                          >
                            <div
                              className={`w-6 h-6 rounded-lg border flex items-center justify-center shrink-0 transition-colors ${
                                isSelected
                                  ? 'bg-indigo-600 border-indigo-600 text-white'
                                  : 'bg-stone-50 dark:bg-zinc-950 border-stone-300 dark:border-zinc-700'
                              }`}
                            >
                              {isSelected && <Check className="w-4 h-4 stroke-[2.5]" />}
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-bold text-zinc-900 dark:text-white truncate">
                                {p.name}
                              </div>
                              <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] lg:text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                                <span className="font-mono tabular-nums">
                                  {p.identity_id || `P-${p.sl_no || '0000'}`}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span className="truncate">{p.school || 'General Institution'}</span>
                                {p.class_or_age && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span>{p.class_or_age}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Right Pane (Laptop 1024px+): Selected Review Panel */}
                <aside className="hidden lg:flex lg:flex-col bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 space-y-3 lg:sticky lg:top-0">
                  <div className="flex items-center justify-between gap-2 pb-2 border-b border-stone-200 dark:border-zinc-800">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-white tabular-nums">
                      Selected ({selectedItems.length})
                    </h3>
                    {selectedItems.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelectedPickerParticipantIds([])}
                        className="text-xs font-semibold text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
                      >
                        Clear all
                      </button>
                    )}
                  </div>

                  {selectedItems.length === 0 ? (
                    <p className="text-xs lg:text-sm text-zinc-500 py-6 text-center">
                      Select participants from the roster to enroll them in one batch.
                    </p>
                  ) : (
                    <div className="space-y-1.5 max-h-[42vh] overflow-y-auto pr-1">
                      {selectedItems.map((p) => (
                        <div
                          key={p.id}
                          className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-stone-50 dark:bg-zinc-950 border border-stone-200/80 dark:border-zinc-800"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-bold text-zinc-900 dark:text-white truncate">
                              {p.name}
                            </div>
                            <div className="text-[11px] text-zinc-500 truncate">
                              {p.school || 'General Institution'}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleToggleParticipantPick(p.id)}
                            aria-label={`Deselect ${p.name}`}
                            className="min-w-[32px] min-h-[32px] rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-stone-200/70 dark:hover:bg-zinc-800 flex items-center justify-center cursor-pointer shrink-0"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </aside>
              </div>
            );
          })()}
      </TaskScreen>

      {/* ======================================================== */}
      {/* FULL-SCREEN JUDGES ASSIGNMENT (TaskScreen)               */}
      {/* ======================================================== */}
      <TaskScreen
        isOpen={Boolean(activeJudgesModalEvent)}
        title={activeJudgesModalEvent?.name || ''}
        subtitle="Jury credentials & scoring authorization"
        onBack={handleCloseJudgesModal}
        hasNestedOverlay={Boolean(isEventActionModalOpen || isJudgePickerOpen)}
        maxWidthClass="md:max-w-2xl"
        primaryAction={{
          label: 'Done',
          onClick: handleCloseJudgesModal,
          variant: 'neutral',
        }}
      >
        {activeJudgesModalEvent &&
          (() => {
            const eventStatus = (activeJudgesModalEvent.status || 'draft').toLowerCase();
            const isLocked = Boolean(activeJudgesModalEvent.is_locked);
            const canModifyJudges =
              !isLocked &&
              eventStatus !== 'active' &&
              eventStatus !== 'ended' &&
              eventStatus !== 'archived';

            const assignedIds = (activeJudgesModalEvent.assigned_judges || []).filter((id) =>
              activeJudgeIdSet.has(id)
            );
            const assignedList = judges.filter(
              (j) => j.is_active !== false && assignedIds.includes(j.id)
            );
            const q = judgeSearch.trim().toLowerCase();
            const filteredAssigned = assignedList.filter(
              (j) =>
                !q ||
                j.name.toLowerCase().includes(q) ||
                (j.judge_id && j.judge_id.toLowerCase().includes(q))
            );

            return (
              <div className="max-w-2xl w-full mx-auto space-y-4">
                {/* Event Status Banner */}
                {isLocked ? (
                  <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 text-amber-800 dark:text-amber-300 text-xs lg:text-sm font-medium flex items-center gap-2">
                    <Lock className="w-4 h-4 text-amber-500 shrink-0" />
                    <span>
                      Roster Locked: Jury assignments are frozen in read-only mode. Judges cannot be assigned or unassigned.
                    </span>
                  </div>
                ) : eventStatus === 'active' ? (
                  <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 text-amber-800 dark:text-amber-300 text-xs lg:text-sm font-medium flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-amber-500 shrink-0" />
                    <span>
                      Event is Live: Jury assignments are locked to ensure score ballot integrity.
                    </span>
                  </div>
                ) : eventStatus === 'ended' || eventStatus === 'archived' ? (
                  <div className="p-3 rounded-xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 text-xs lg:text-sm font-medium flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-zinc-500 shrink-0" />
                    <span>
                      Event is Ended: Jury records are sealed. No judges can be modified.
                    </span>
                  </div>
                ) : null}

                {/* Single Primary Action + Count */}
                <div className="flex flex-wrap items-center justify-between gap-2.5">
                  <div className="flex items-center gap-3">
                    {canModifyJudges && (
                      <button
                        type="button"
                        onClick={() => {
                          setJudgePickerSearch('');
                          setSelectedPickerJudgeIds([]);
                          setIsJudgePickerOpen(true);
                        }}
                        className="min-h-[44px] px-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-xs lg:text-sm font-bold flex items-center gap-2 active:scale-[0.98] transition-[transform,colors] duration-100 motion-reduce:transition-none shadow-xs cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <Plus className="w-4 h-4 shrink-0" />
                        <span>Add judges</span>
                      </button>
                    )}
                    <span className="text-xs lg:text-sm font-semibold text-zinc-500 dark:text-zinc-400 tabular-nums">
                      {assignedList.length} {assignedList.length === 1 ? 'judge' : 'judges'}
                    </span>
                  </div>
                </div>

                {assignedList.length === 0 ? (
                  <div className="p-8 text-center bg-white dark:bg-zinc-950 border border-dashed border-stone-200 dark:border-zinc-800 rounded-2xl space-y-2">
                    <Gavel className="w-8 h-8 mx-auto text-zinc-300 dark:text-zinc-700" />
                    <h4 className="text-sm font-bold text-zinc-800 dark:text-white">
                      No Judges Assigned
                    </h4>
                    <p className="text-xs lg:text-sm text-zinc-500">
                      {canModifyJudges
                        ? 'Use "Add judges" above to select judges for this event.'
                        : 'No judges are assigned to this event.'}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="relative">
                      <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        placeholder="Search assigned judges by name or Judge ID..."
                        value={judgeSearch}
                        onChange={(e) => setJudgeSearch(e.target.value)}
                        className="w-full min-h-[44px] pl-9 pr-3 text-xs lg:text-sm bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-xl text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                      />
                    </div>

                    {filteredAssigned.length === 0 ? (
                      <div className="p-6 text-center text-xs lg:text-sm text-zinc-500">
                        No assigned judges match your search.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {filteredAssigned.map((j) => (
                          <div
                            key={j.id}
                            className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800/80 rounded-2xl p-3.5 flex items-center justify-between gap-3 shadow-xs"
                          >
                            <div className="flex items-center gap-3 min-w-0 flex-1">
                              <div className="w-9 h-9 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 flex items-center justify-center shrink-0">
                                <Scale className="w-4 h-4" />
                              </div>

                              <div className="min-w-0 flex-1">
                                <span className="text-sm font-bold text-zinc-900 dark:text-white block truncate">
                                  {j.name}
                                </span>
                                <div className="flex items-center gap-1.5 text-[11px] lg:text-sm text-zinc-500 font-mono tabular-nums mt-0.5">
                                  <span>ID: {j.judge_id || j.id.slice(0, 8)}</span>
                                  <span aria-hidden="true">·</span>
                                  <span>PIN: {j.pin || '****'}</span>
                                </div>
                              </div>
                            </div>

                            {!isLocked && (
                              <button
                                type="button"
                                onClick={() => handleToggleJudgeInEvent(j.id)}
                                title="Remove judge from event"
                                aria-label={`Remove ${j.name} from event`}
                                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-zinc-400 hover:text-red-500 hover:bg-red-500/10 active:scale-95 transition-[transform,colors] duration-100 motion-reduce:transition-none cursor-pointer shrink-0"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
      </TaskScreen>

      {/* ======================================================== */}
      {/* JUDGES PICKER (TaskScreen — Two-Pane on Laptop)          */}
      {/* ======================================================== */}
      <TaskScreen
        isOpen={Boolean(activeJudgesModalEvent && isJudgePickerOpen)}
        title="Add Judges"
        subtitle={activeJudgesModalEvent?.name || ''}
        onBack={handleCloseJudgePicker}
        maxWidthClass="md:max-w-2xl lg:max-w-5xl"
        secondaryAction={{
          label: 'Cancel',
          onClick: handleCloseJudgePicker,
          disabled: isBatchAssigningJudges,
        }}
        primaryAction={{
          label:
            selectedPickerJudgeIds.length > 0
              ? `Add ${selectedPickerJudgeIds.length} ${
                  selectedPickerJudgeIds.length === 1 ? 'judge' : 'judges'
                }`
              : 'Add judges',
          loading: isBatchAssigningJudges,
          loadingLabel: 'Assigning...',
          disabled:
            isBatchAssigningJudges ||
            selectedPickerJudgeIds.length === 0 ||
            !activeJudgesModalEvent ||
            Boolean(activeJudgesModalEvent.is_locked) ||
            (activeJudgesModalEvent.status || 'draft').toLowerCase() === 'active' ||
            (activeJudgesModalEvent.status || 'draft').toLowerCase() === 'ended' ||
            (activeJudgesModalEvent.status || 'draft').toLowerCase() === 'archived',
          onClick: () => void handleBatchAssignJudgesToEvent(selectedPickerJudgeIds),
          variant: 'amber',
        }}
        footer={
          <span className="text-xs lg:text-sm font-semibold text-zinc-600 dark:text-zinc-300 tabular-nums">
            {selectedPickerJudgeIds.length > 0
              ? `${selectedPickerJudgeIds.length} selected`
              : 'Select judges to assign'}
          </span>
        }
      >
        {activeJudgesModalEvent &&
          (() => {
            const eventStatus = (activeJudgesModalEvent.status || 'draft').toLowerCase();
            const canAddJudges =
              !activeJudgesModalEvent.is_locked &&
              eventStatus !== 'active' &&
              eventStatus !== 'ended' &&
              eventStatus !== 'archived';

            const assignedSet = new Set(activeJudgesModalEvent.assigned_judges || []);
            const availableJudges = judges.filter(
              (j) => j.is_active !== false && !assignedSet.has(j.id)
            );
            const q = judgePickerSearch.trim().toLowerCase();
            const filteredAvailable = availableJudges.filter(
              (j) =>
                !q ||
                j.name.toLowerCase().includes(q) ||
                (j.judge_id && j.judge_id.toLowerCase().includes(q))
            );

            const selectedSet = new Set(selectedPickerJudgeIds);
            const selectedItems = availableJudges.filter((j) => selectedSet.has(j.id));
            const eligibleFilteredIds = canAddJudges ? filteredAvailable.map((j) => j.id) : [];

            const handleToggleJudgePick = (id: string) => {
              if (!canAddJudges) return;
              setSelectedPickerJudgeIds((prev) =>
                prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
              );
            };

            const handleSelectAllFilteredJudges = () => {
              if (!canAddJudges || eligibleFilteredIds.length === 0) return;
              setSelectedPickerJudgeIds((prev) => {
                const next = new Set(prev);
                eligibleFilteredIds.forEach((id) => next.add(id));
                return Array.from(next);
              });
            };

            return (
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-5 items-start">
                {/* Left Pane (or Full Screen on Phone): Search + Toolbar + Judge Checklist */}
                <div className="space-y-3 min-w-0">
                  {!canAddJudges && (
                    <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 text-amber-800 dark:text-amber-300 text-xs lg:text-sm font-medium flex items-center gap-2">
                      <Lock className="w-4 h-4 shrink-0" />
                      <span>
                        Assigning judges is blocked while this event is live, ended, or locked.
                      </span>
                    </div>
                  )}

                  <div className="relative">
                    <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      placeholder="Search unassigned judges by name or Judge ID..."
                      value={judgePickerSearch}
                      onChange={(e) => setJudgePickerSearch(e.target.value)}
                      className="w-full min-h-[44px] pl-9 pr-3 text-xs lg:text-sm bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-xl text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={!canAddJudges || eligibleFilteredIds.length === 0}
                        onClick={handleSelectAllFilteredJudges}
                        className="min-h-[40px] px-3 rounded-xl border border-stone-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs font-bold text-zinc-800 dark:text-zinc-200 hover:bg-stone-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors whitespace-nowrap shrink-0"
                      >
                        Select all
                      </button>
                      {selectedPickerJudgeIds.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSelectedPickerJudgeIds([])}
                          className="min-h-[40px] px-3 rounded-xl text-xs font-semibold text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white cursor-pointer whitespace-nowrap shrink-0"
                        >
                          Clear
                        </button>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => handleCreateNewFromPicker('judge')}
                      className="min-h-[40px] px-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-500/20 text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap shrink-0"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Create new</span>
                    </button>
                  </div>

                  {availableJudges.length === 0 ? (
                    <div className="p-8 text-center bg-white dark:bg-zinc-900 border border-dashed border-stone-200 dark:border-zinc-800 rounded-2xl space-y-3">
                      <Gavel className="w-8 h-8 mx-auto text-zinc-300 dark:text-zinc-700" />
                      <div className="space-y-1">
                        <h4 className="text-sm font-bold text-zinc-900 dark:text-white">
                          No Unassigned Judges
                        </h4>
                        <p className="text-xs lg:text-sm text-zinc-500">
                          All active judges in your organization are already assigned to this event.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleCreateNewFromPicker('judge')}
                        className="min-h-[44px] px-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-xs lg:text-sm font-bold inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <Plus className="w-4 h-4" />
                        <span>Create new judge</span>
                      </button>
                    </div>
                  ) : filteredAvailable.length === 0 ? (
                    <div className="p-6 text-center bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl space-y-2">
                      <p className="text-xs lg:text-sm text-zinc-500">
                        No unassigned judges match &quot;{judgePickerSearch}&quot;.
                      </p>
                      <button
                        type="button"
                        onClick={() => handleCreateNewFromPicker('judge')}
                        className="min-h-[40px] px-3 rounded-xl text-xs font-bold text-amber-700 dark:text-amber-400 hover:underline cursor-pointer"
                      >
                        Create new judge in People tab
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {filteredAvailable.map((j) => {
                        const isSelected = selectedSet.has(j.id);
                        return (
                          <button
                            key={j.id}
                            type="button"
                            disabled={!canAddJudges}
                            aria-pressed={isSelected}
                            onClick={() => handleToggleJudgePick(j.id)}
                            className={`w-full min-h-[58px] text-left p-3.5 rounded-2xl border flex items-center gap-3 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                              isSelected
                                ? 'bg-amber-50/70 dark:bg-amber-950/30 border-amber-400 dark:border-amber-500/60'
                                : 'bg-white dark:bg-zinc-900 border-stone-200 dark:border-zinc-800 hover:border-stone-300 dark:hover:border-zinc-700'
                            }`}
                          >
                            <div
                              className={`w-6 h-6 rounded-lg border flex items-center justify-center shrink-0 transition-colors ${
                                isSelected
                                  ? 'bg-amber-500 border-amber-500 text-black'
                                  : 'bg-stone-50 dark:bg-zinc-950 border-stone-300 dark:border-zinc-700'
                              }`}
                            >
                              {isSelected && <Check className="w-4 h-4 stroke-[2.5]" />}
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-bold text-zinc-900 dark:text-white truncate">
                                {j.name}
                              </div>
                              <div className="text-[11px] lg:text-xs text-zinc-500 font-mono tabular-nums mt-0.5">
                                ID: {j.judge_id || j.id.slice(0, 8)}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Right Pane (Laptop 1024px+): Selected Review Panel */}
                <aside className="hidden lg:flex lg:flex-col bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 space-y-3 lg:sticky lg:top-0">
                  <div className="flex items-center justify-between gap-2 pb-2 border-b border-stone-200 dark:border-zinc-800">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-white tabular-nums">
                      Selected ({selectedItems.length})
                    </h3>
                    {selectedItems.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelectedPickerJudgeIds([])}
                        className="text-xs font-semibold text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
                      >
                        Clear all
                      </button>
                    )}
                  </div>

                  {selectedItems.length === 0 ? (
                    <p className="text-xs lg:text-sm text-zinc-500 py-6 text-center">
                      Select judges from the roster to assign them in one batch.
                    </p>
                  ) : (
                    <div className="space-y-1.5 max-h-[42vh] overflow-y-auto pr-1">
                      {selectedItems.map((j) => (
                        <div
                          key={j.id}
                          className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-stone-50 dark:bg-zinc-950 border border-stone-200/80 dark:border-zinc-800"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-bold text-zinc-900 dark:text-white truncate">
                              {j.name}
                            </div>
                            <div className="text-[11px] text-zinc-500 font-mono tabular-nums truncate">
                              ID: {j.judge_id || j.id.slice(0, 8)}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleToggleJudgePick(j.id)}
                            aria-label={`Deselect ${j.name}`}
                            className="min-w-[32px] min-h-[32px] rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-stone-200/70 dark:hover:bg-zinc-800 flex items-center justify-center cursor-pointer shrink-0"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </aside>
              </div>
            );
          })()}
      </TaskScreen>

      {/* ======================================================== */}
      {/* EVENT DOSSIER MODAL (Portaled, triggered by Eye icon)    */}
      {/* ======================================================== */}
      {dossierEvent &&
        (() => {
          const dossierNode = (
            <div
              className="fixed inset-0 z-[120] bg-black/75 flex items-center justify-center p-3 sm:p-4 animate-in fade-in duration-200 motion-reduce:animate-none pointer-events-auto"
              onClick={() => setDossierEventId(null)}
            >
              <div
                ref={dossierDialogRef}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-label={dossierEvent.name}
                onClick={(e) => e.stopPropagation()}
                className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-3xl max-w-xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in zoom-in-95 motion-reduce:animate-none focus:outline-none"
              >
            {/* Header */}
            <div className="px-5 py-4 border-b border-stone-200 dark:border-zinc-800 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 flex items-center justify-center">
                  <Eye className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-zinc-900 dark:text-white leading-tight">
                    {dossierEvent.name}
                  </h3>
                  <p className="text-[11px] lg:text-sm text-zinc-500 font-mono">
                    {dossierEvent.category || 'General'} • Status: {dossierEvent.status?.toUpperCase()}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setDossierEventId(null)}
                className="w-8 h-8 md:w-11 md:h-11 rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Scrollable Dossier Content */}
            <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs lg:text-sm">
              {/* Section 1: Rubric Schema */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold uppercase tracking-wider text-zinc-500 text-[10px] lg:text-sm">
                    Rubric Criteria Schema
                  </span>
                  <span className="font-mono text-emerald-600 dark:text-emerald-400 font-bold">
                    {(dossierEvent.rubric_schema || dossierEvent.rubric || []).reduce(
                      (sum, c) => sum + (Number(c.max_marks) || 0),
                      0
                    )}{' '}
                    Total Points
                  </span>
                </div>

                <div className="rounded-xl border border-stone-200 dark:border-zinc-800 overflow-hidden divide-y divide-stone-100 dark:divide-zinc-850">
                  {(dossierEvent.rubric_schema || dossierEvent.rubric || []).map((c, i) => (
                    <div key={c.id || i} className="p-2.5 flex items-center justify-between bg-white dark:bg-zinc-950">
                      <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                        {i + 1}. {c.name}
                      </span>
                      <span className="font-mono font-bold text-zinc-500">
                        Max: {c.max_marks} pts
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Section 2: Assigned Judges */}
              <div className="space-y-2">
                <span className="font-bold uppercase tracking-wider text-zinc-500 text-[10px] lg:text-sm block">
                  Jury Panel ({(dossierEvent.assigned_judges || []).filter((id) => activeJudgeIdSet.has(id)).length})
                </span>

                {(dossierEvent.assigned_judges || []).filter((id) => activeJudgeIdSet.has(id)).length === 0 ? (
                  <div className="p-3 rounded-xl bg-stone-50 dark:bg-zinc-900 text-zinc-400 text-center">
                    No judges assigned yet.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {(dossierEvent.assigned_judges || []).filter((id) => activeJudgeIdSet.has(id)).map((jId) => {
                      const jObj = judgeMap.get(jId);
                      return (
                        <div
                          key={jId}
                          className="p-2.5 rounded-xl border border-stone-200 dark:border-zinc-800 border-t-white/5 bg-stone-50/50 dark:bg-zinc-900 flex items-center justify-between"
                        >
                          <span className="font-bold text-zinc-900 dark:text-white truncate">
                            ⚖️ {jObj?.name || jId.slice(0, 8)}
                          </span>
                          <span className="text-[10px] lg:text-xs font-mono text-zinc-400">
                            {jObj?.judge_id || 'J-ID'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Section 3: Assigned Participants */}
              <div className="space-y-2">
                <span className="font-bold uppercase tracking-wider text-zinc-500 text-[10px] lg:text-sm block">
                  Enrolled Competitors ({(dossierEvent.assigned_participants || []).filter((id) => activeParticipantIdSet.has(id)).length})
                </span>

                {(dossierEvent.assigned_participants || []).filter((id) => activeParticipantIdSet.has(id)).length === 0 ? (
                  <div className="p-3 rounded-xl bg-stone-50 dark:bg-zinc-900 text-zinc-400 text-center">
                    No participants enrolled yet.
                  </div>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                    {(dossierEvent.assigned_participants || []).filter((id) => activeParticipantIdSet.has(id)).map((pId, idx) => {
                      const pObj = participantMap.get(pId);
                      const serial =
                        dossierEvent.participant_sl_numbers?.[pId] ||
                        String(idx + 1).padStart(2, '0');

                      return (
                        <div
                          key={pId}
                          className="p-2 rounded-xl border border-stone-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex items-center justify-between"
                        >
                          <div className="flex items-center gap-2 truncate">
                            <span className="font-mono font-bold text-zinc-400 text-[11px] lg:text-sm">
                              #{serial}
                            </span>
                            <span className="font-bold text-zinc-900 dark:text-white truncate">
                              {pObj?.name || 'Unknown Competitor'}
                            </span>
                          </div>
                          <span className="text-[10px] lg:text-sm text-zinc-500 truncate max-w-[120px]">
                            {pObj?.school || 'General'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-stone-200 dark:border-zinc-800 bg-stone-50 dark:bg-zinc-900 flex justify-end shrink-0">
              <button
                type="button"
                onClick={() => setDossierEventId(null)}
                className="min-h-[38px] md:min-h-[44px] px-5 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black text-xs lg:text-sm font-bold active:scale-95 transition-transform duration-100 motion-reduce:transition-none cursor-pointer"
              >
                Close Dossier
              </button>
            </div>
          </div>
            </div>
          );
          return typeof document !== 'undefined' ? createPortal(dossierNode, document.body) : dossierNode;
        })()}

      {/* ======================================================== */}
      {/* CUSTOM CONFIRMATION MODAL (DELETE & DUPLICATE, Portaled) */}
      {/* ======================================================== */}
      {eventModalState &&
        eventModalState.isOpen &&
        (() => {
          const closeActionModal = () => {
            setEventModalState(null);
            setDeleteConfirmText('');
            setMasterPasswordInput('');
            setPasswordError(null);
          };
          const modalNode = (
            <div
              className="fixed inset-0 z-[140] bg-black/75 flex items-center justify-center p-4 animate-in fade-in duration-150 motion-reduce:animate-none pointer-events-auto"
              style={
                eventActionKeyboardInset > 0
                  ? { paddingBottom: `${eventActionKeyboardInset}px` }
                  : undefined
              }
              onClick={closeActionModal}
            >
              <div
                ref={eventActionDialogRef}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-label={
                  eventModalState.type === 'delete_draft'
                    ? 'Delete Event?'
                    : eventModalState.type === 'delete_ended'
                    ? 'Delete Ended Event'
                    : 'Duplicate as Draft?'
                }
                onClick={(e) => e.stopPropagation()}
                onFocusCapture={(e) => scrollFocusedInputIntoView(e.target)}
                className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-3xl max-w-sm w-full max-h-full overflow-y-auto p-6 space-y-4 shadow-2xl animate-in zoom-in-95 motion-reduce:animate-none focus:outline-none"
              >
            {eventModalState.type === 'delete_draft' ? (
              <>
                <div className="flex items-center space-x-3 text-red-600 dark:text-red-400">
                  <div className="w-10 h-10 rounded-2xl bg-red-500/15 flex items-center justify-center">
                    <Trash2 className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-zinc-900 dark:text-white leading-tight">
                      Delete Event?
                    </h3>
                    <p className="text-xs lg:text-sm text-red-600 dark:text-red-400 font-mono">
                      Double-confirmation required
                    </p>
                  </div>
                </div>

                <p className="text-xs lg:text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  Permanently delete <strong className="text-zinc-900 dark:text-white">{eventModalState.eventName}</strong>? This action cannot be undone.
                </p>

                <div className="space-y-1.5 pt-1">
                  <label className="text-[11px] lg:text-sm font-semibold text-zinc-500 dark:text-zinc-400">
                    Type <span className="font-mono font-bold text-red-500">DELETE</span> or the event name:
                  </label>
                  <input
                    type="text"
                    autoFocus
                    placeholder={`Type "DELETE" or "${eventModalState.eventName}"`}
                    value={deleteConfirmText}
                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                    className="w-full min-h-[42px] md:min-h-[44px] px-3.5 text-xs lg:text-sm bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-zinc-900 dark:text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-red-500/50"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEventModalState(null);
                      setDeleteConfirmText('');
                    }}
                    className="min-h-[42px] md:min-h-[44px] bg-stone-100 hover:bg-stone-200 dark:bg-zinc-900 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs lg:text-sm font-bold rounded-xl active:scale-95 transition-[transform,colors] duration-100 motion-reduce:transition-none cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={
                      deleteConfirmText.trim() !== 'DELETE' &&
                      deleteConfirmText.trim() !== eventModalState.eventName.trim()
                    }
                    onClick={handleConfirmModalAction}
                    className="min-h-[42px] md:min-h-[44px] bg-red-600 hover:bg-red-500 text-white text-xs lg:text-sm font-bold rounded-xl shadow-lg shadow-red-600/25 active:scale-95 transition-[transform,colors] duration-100 motion-reduce:transition-none cursor-pointer flex items-center justify-center space-x-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>Delete Event</span>
                  </button>
                </div>
              </>
            ) : eventModalState.type === 'delete_ended' ? (
              <>
                <div className="flex items-center space-x-3 text-red-600 dark:text-red-400">
                  <div className="w-10 h-10 rounded-2xl bg-red-500/15 flex items-center justify-center">
                    <KeyRound className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-zinc-900 dark:text-white leading-tight">
                      Delete Ended Event
                    </h3>
                    <p className="text-xs lg:text-sm text-amber-500 font-mono">
                      Master Password Required
                    </p>
                  </div>
                </div>

                <p className="text-xs lg:text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  <strong className="text-zinc-900 dark:text-white">{eventModalState.eventName}</strong> has completed. To protect ledger integrity, verify your <strong className="text-zinc-900 dark:text-white">Organization Master Password</strong> to authorize permanent deletion (works 100% offline).
                </p>

                <div className="space-y-1.5 pt-1">
                  <label className="text-[11px] lg:text-sm font-semibold text-zinc-500 dark:text-zinc-400">
                    Master Password:
                  </label>
                  <input
                    type="password"
                    autoFocus
                    placeholder="Enter Organization Master Password"
                    value={masterPasswordInput}
                    onChange={(e) => {
                      setMasterPasswordInput(e.target.value);
                      setPasswordError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && masterPasswordInput.trim()) {
                        handleConfirmModalAction();
                      }
                    }}
                    className="w-full min-h-[42px] md:min-h-[44px] px-3.5 text-xs lg:text-sm bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-zinc-900 dark:text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-red-500/50"
                  />
                  {passwordError && (
                    <p className="text-[11px] lg:text-sm text-red-500 font-medium animate-in fade-in motion-reduce:animate-none">
                      {passwordError}
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEventModalState(null);
                      setMasterPasswordInput('');
                      setPasswordError(null);
                    }}
                    className="min-h-[42px] md:min-h-[44px] bg-stone-100 hover:bg-stone-200 dark:bg-zinc-900 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs lg:text-sm font-bold rounded-xl active:scale-95 transition-[transform,colors] duration-100 motion-reduce:transition-none cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!masterPasswordInput.trim()}
                    onClick={handleConfirmModalAction}
                    className="min-h-[42px] md:min-h-[44px] bg-red-600 hover:bg-red-500 text-white text-xs lg:text-sm font-bold rounded-xl shadow-lg shadow-red-600/25 active:scale-95 transition-[transform,colors] duration-100 motion-reduce:transition-none cursor-pointer flex items-center justify-center space-x-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <KeyRound className="w-4 h-4" />
                    <span>Verify &amp; Delete</span>
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center space-x-3 text-zinc-900 dark:text-white">
                  <div className="w-10 h-10 rounded-2xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                    <Copy className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-zinc-900 dark:text-white leading-tight">
                      Duplicate as Draft?
                    </h3>
                    <p className="text-xs lg:text-sm text-zinc-500 font-mono">
                      Create template copy
                    </p>
                  </div>
                </div>

                <p className="text-xs lg:text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  Create an independent draft copy of <strong className="text-zinc-900 dark:text-white">{eventModalState.eventName}</strong> with all rubric criteria and roster configurations.
                </p>

                <div className="grid grid-cols-2 gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => setEventModalState(null)}
                    className="min-h-[42px] md:min-h-[44px] bg-stone-100 hover:bg-stone-200 dark:bg-zinc-900 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs lg:text-sm font-bold rounded-xl active:scale-95 transition-[transform,colors] duration-100 motion-reduce:transition-none cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmModalAction}
                    className="min-h-[42px] md:min-h-[44px] bg-zinc-900 hover:bg-zinc-800 dark:bg-white dark:hover:bg-zinc-100 text-white dark:text-black text-xs lg:text-sm font-bold rounded-xl active:scale-95 transition-[transform,colors] duration-100 motion-reduce:transition-none cursor-pointer flex items-center justify-center space-x-1.5 shadow-sm"
                  >
                    <Copy className="w-4 h-4" />
                    <span>Duplicate as Draft</span>
                  </button>
                </div>
              </>
            )}
          </div>
            </div>
          );
          return typeof document !== 'undefined' ? createPortal(modalNode, document.body) : modalNode;
        })()}

      {/* ======================================================== */}
      {/* FLOATING ACTION BUTTON (FAB) FOR "+ CREATE EVENT"        */}
      {/* ======================================================== */}
      <button
        type="button"
        onClick={handleOpenCreateWizard}
        className="md:hidden fixed bottom-24 right-6 z-50 w-14 h-14 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl shadow-xl shadow-emerald-900/30 flex items-center justify-center active:scale-95 transition-[transform,colors] duration-100 motion-reduce:transition-none cursor-pointer"
        aria-label="Create Event"
        title="Create Event"
      >
        <Plus className="w-6 h-6 stroke-[2.5]" />
      </button>
    </>
  );
}
