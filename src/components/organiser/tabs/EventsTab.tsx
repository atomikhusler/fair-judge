import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { 
  Plus, 
  Search, 
  Edit3, 
  Trash2, 
  Archive, 
  Users, 
  Gavel, 
  X, 
  Check, 
  AlertTriangle, 
  Copy, 
  Bookmark, 
  Sparkles,
  Eye,
  ArrowLeft,
  UserPlus,
  ShieldCheck,
  Hash,
  School,
  GraduationCap,
  Calendar,
  Layers,
  ChevronRight,
  GripVertical,
  ChevronUp,
  ChevronDown,
  Lock
} from 'lucide-react';
import { 
  Organization, 
  SupabaseEvent, 
  SupabaseJudge, 
  SupabaseParticipant, 
  EventStatus,
  RubricCriterion 
} from '../../../lib/supabaseTypes';
import { dbService, generateUUID, subscribeToDatabase } from '../../../lib/supabase';

interface EventsTabProps {
  organization: Organization;
  onOpenPublicView?: (eventId?: string) => void;
  onNavigateToLiveControl?: (eventId: string) => void;
}

type FilterStatus = 'all' | 'active' | 'upcoming' | 'draft' | 'ended';

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

export function EventsTab({
  organization,
  onOpenPublicView,
  onNavigateToLiveControl,
}: EventsTabProps) {
  // ========================================================
  // 1. MAIN EVENT LIBRARY STATE
  // ========================================================
  const [events, setEvents] = useState<SupabaseEvent[]>([]);
  const [participants, setParticipants] = useState<SupabaseParticipant[]>([]);
  const [judges, setJudges] = useState<SupabaseJudge[]>([]);
  const [scoresMap, setScoresMap] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Custom Framer-Style Modal State (Delete & Duplicate confirmations)
  const [eventModalState, setEventModalState] = useState<{
    isOpen: boolean;
    type: 'delete' | 'duplicate';
    eventId: string;
    eventName: string;
    canDelete?: boolean;
  } | null>(null);

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
  const [rubricCriteria, setRubricCriteria] = useState<RubricItem[]>([
    { id: generateUUID(), name: 'Concept & Originality', maxMarks: 10 },
    { id: generateUUID(), name: 'Execution & Technique', maxMarks: 10 },
    { id: generateUUID(), name: 'Defense & Q&A', maxMarks: 5 },
  ]);

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

  // Modal local search & enrollment sub-panels
  const [participantSearch, setParticipantSearch] = useState('');
  const [judgeSearch, setJudgeSearch] = useState('');
  const [isEnrollDrawerOpen, setIsEnrollDrawerOpen] = useState(false);
  const [isAssignJudgeDrawerOpen, setIsAssignJudgeDrawerOpen] = useState(false);

  // Lineup Builder Drag & Drop State
  const [draggedParticipantIndex, setDraggedParticipantIndex] = useState<number | null>(null);
  const [dragOverParticipantIndex, setDragOverParticipantIndex] = useState<number | null>(null);

  // Clean Modal Close Helpers (Resets sub-drawers & drag states)
  const handleCloseParticipantsModal = useCallback(() => {
    setActiveParticipantsEventId(null);
    setIsEnrollDrawerOpen(false);
    setParticipantSearch('');
    setDraggedParticipantIndex(null);
    setDragOverParticipantIndex(null);
  }, []);

  const handleCloseJudgesModal = useCallback(() => {
    setActiveJudgesEventId(null);
    setIsAssignJudgeDrawerOpen(false);
    setJudgeSearch('');
  }, []);

  // Lock document body scroll whenever any full-screen modal or confirmation popup is active
  const isAnyModalOpen = Boolean(
    isWizardOpen ||
    isUnsavedExitModalOpen ||
    activeParticipantsModalEvent ||
    activeJudgesModalEvent ||
    dossierEvent ||
    eventModalState?.isOpen
  );

  useEffect(() => {
    if (isAnyModalOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [isAnyModalOpen]);

  // Storage key for auto-save draft recovery
  const draftStorageKey = useMemo(
    () => `fairjudge_event_draft_${organization.org_id.toUpperCase()}`,
    [organization.org_id]
  );

  // Toast notification helper with auto-dismiss
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((current) => (current === msg ? null : current));
    }, 3500);
  }, []);

  // ========================================================
  // 4. DATA LOADING & REALTIME SYNC (Stable dependencies)
  // ========================================================
  const loadData = useCallback(async () => {
    try {
      const [eList, pList, jList] = await Promise.all([
        dbService.getEvents(organization.org_id),
        dbService.getParticipants(organization.org_id),
        dbService.getJudges(organization.org_id),
      ]);
      setEvents(eList);
      setParticipants(pList);
      setJudges(jList);

      // Load score counts for ledger immutability checking
      const scoreCounts: Record<string, number> = {};
      await Promise.all(
        eList.map(async (ev) => {
          try {
            const sc = await dbService.getScores(ev.id);
            scoreCounts[ev.id] = sc.length;
          } catch {
            scoreCounts[ev.id] = 0;
          }
        })
      );
      setScoresMap(scoreCounts);
    } catch (err) {
      console.error('Failed to load events data:', err);
    } finally {
      setIsLoading(false);
    }
  }, [organization.org_id]);

  useEffect(() => {
    loadData();
    const unsubscribe = subscribeToDatabase(() => {
      loadData();
    });
    return () => unsubscribe();
  }, [loadData]);

  // Draft recovery check
  const checkForDraft = useCallback((): DraftState | null => {
    try {
      const saved = localStorage.getItem(draftStorageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as DraftState;
        if (parsed.name?.trim()) {
          return parsed;
        }
      }
    } catch {}
    return null;
  }, [draftStorageKey]);

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

    const draft = checkForDraft();
    if (draft) {
      setCachedDraft(draft);
      setShowDraftBanner(true);
    } else {
      setShowDraftBanner(false);
      setCachedDraft(null);
    }

    setEventName('');
    setEventCategory('');
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
    setRubricCriteria(cachedDraft.rubricCriteria || []);
    setShowDraftBanner(false);
    setIsDirty(true);
    showToast('Draft recovered successfully.');
  };

  const handleDiscardDraft = () => {
    clearDraft();
    setEventName('');
    setEventCategory('');
    setRubricCriteria([
      { id: generateUUID(), name: 'Concept & Originality', maxMarks: 10 },
      { id: generateUUID(), name: 'Execution & Technique', maxMarks: 10 },
      { id: generateUUID(), name: 'Defense & Q&A', maxMarks: 5 },
    ]);
    setIsDirty(false);
    showToast('Draft cleared. Starting fresh.');
  };

  const handleCloseWizard = () => {
    if (isDirty) {
      setIsUnsavedExitModalOpen(true);
      return;
    }
    setIsWizardOpen(false);
    setIsDirty(false);
    setShowDraftBanner(false);
  };

  const handleForceDiscardAndExit = () => {
    clearDraft();
    setIsUnsavedExitModalOpen(false);
    setIsWizardOpen(false);
    setIsDirty(false);
    setShowDraftBanner(false);
  };

  const handleSaveDraftAndExit = async () => {
    setIsUnsavedExitModalOpen(false);
    await handleSaveEvent();
  };

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
    setIsLoading(true);
    try {
      const scores = await dbService.getScores(evt.id);
      setEditingEventId(evt.id);
      setHasExistingScores(scores.length > 0);
      setShowDraftBanner(false);

      setEventName(evt.name || '');
      setEventCategory(evt.category || '');

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
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteClick = async (e: React.MouseEvent, evt: SupabaseEvent) => {
    e.stopPropagation();
    const status = (evt.status || 'draft').toLowerCase();

    // Live event cannot be deleted directly (must end or pause first)
    if (status === 'active') {
      showToast('Prohibited: Cannot delete an event while it is live. End session first.');
      return;
    }

    // STRICT RULE: Only event can be deleted once ended/completed
    const canDelete = await dbService.canDeleteEvent(evt.id);
    setEventModalState({
      isOpen: true,
      type: 'delete',
      eventId: evt.id,
      eventName: evt.name,
      canDelete,
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

    if (type === 'delete') {
      try {
        const res = await dbService.deleteOrArchiveEvent(eventId);
        if (res.action === 'deleted') {
          showToast(`Event "${targetName}" was permanently deleted.`);
        } else {
          showToast(`Event "${targetName}" was safely archived.`);
        }
        if (isWizardOpen && editingEventId === eventId) {
          setIsWizardOpen(false);
          setIsDirty(false);
        }
        await loadData();
      } catch (err) {
        console.error('Failed to delete/archive event:', err);
        showToast('Action failed.');
      } finally {
        setEventModalState(null);
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

  const handleAddCriterion = () => {
    if (hasExistingScores) {
      showToast('Rubric schema is locked to preserve ledger integrity.');
      return;
    }
    setIsDirty(true);
    setRubricCriteria((prev) => [
      ...prev,
      { id: generateUUID(), name: '', maxMarks: 10 },
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
    setIsDirty(true);
    setRubricCriteria((prev) => prev.filter((c) => c.id !== id));
  };

  const handleApplyPreset = (preset: typeof RUBRIC_PRESETS[0]) => {
    if (hasExistingScores) {
      showToast('Rubric schema is locked for this event.');
      return;
    }
    setIsDirty(true);
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
  const isFormValid = Boolean(eventName.trim());

  const handleSaveEvent = async () => {
    if (!isFormValid) {
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
      const updatedSerialMap = { ...(activeParticipantsModalEvent.participant_sl_numbers || {}) };
      delete updatedSerialMap[participantId];

      const isNowReady = updatedList.length > 0 && (activeParticipantsModalEvent.assigned_judges || []).length > 0;
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

  const handleEnrollParticipantToEvent = async (participantId: string) => {
    if (!activeParticipantsModalEvent) return;
    const status = (activeParticipantsModalEvent.status || 'draft').toLowerCase();

    // RULE: once event is ended, no one can add participants
    if (status === 'ended' || status === 'archived') {
      showToast('Prohibited: Cannot add participants to an ended event.');
      return;
    }

    // Live event CAN add participants while continuing!
    try {
      const currentAssigned = activeParticipantsModalEvent.assigned_participants || [];
      if (currentAssigned.includes(participantId)) return;

      const nextSerialNum = currentAssigned.length + 1;
      const formattedSerial = String(nextSerialNum).padStart(2, '0');

      const updatedList = [...currentAssigned, participantId];
      const updatedSerialMap = {
        ...(activeParticipantsModalEvent.participant_sl_numbers || {}),
        [participantId]: formattedSerial,
      };

      const isNowReady = updatedList.length > 0 && (activeParticipantsModalEvent.assigned_judges || []).length > 0;
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
      showToast('Participant enrolled in event.');
    } catch (err) {
      console.error('Failed to enroll participant:', err);
      showToast('Error enrolling participant.');
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

      const isNowReady = (activeJudgesModalEvent.assigned_participants || []).length > 0 && updatedJudges.length > 0;
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

  // ========================================================
  // 11. FILTER & SEARCH LOGIC
  // ========================================================
  const statusCounts = useMemo(() => {
    const counts = { all: events.length, active: 0, upcoming: 0, draft: 0, ended: 0 };
    events.forEach((e) => {
      const st = (e.status || 'draft').toLowerCase();
      const hasBoth = (e.assigned_participants || []).length > 0 && (e.assigned_judges || []).length > 0;
      if (st === 'active') counts.active++;
      else if (st === 'ended' || st === 'archived') counts.ended++;
      else if (st === 'ready' || st === 'upcoming' || hasBoth) counts.upcoming++;
      else counts.draft++;
    });
    return counts;
  }, [events]);

  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      const matchesSearch =
        searchQuery.trim() === '' ||
        e.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (e.category && e.category.toLowerCase().includes(searchQuery.toLowerCase()));

      const st = (e.status || 'draft').toLowerCase();
      const hasBoth = (e.assigned_participants || []).length > 0 && (e.assigned_judges || []).length > 0;
      const isReadyOrUpcoming = st === 'ready' || st === 'upcoming' || (st === 'draft' && hasBoth);
      const isDraftOnly = st === 'draft' && !hasBoth;

      if (!matchesSearch) return false;

      if (filterStatus === 'all') return true;
      if (filterStatus === 'active') return st === 'active';
      if (filterStatus === 'upcoming') return isReadyOrUpcoming;
      if (filterStatus === 'draft') return isDraftOnly;
      if (filterStatus === 'ended') return st === 'ended' || st === 'archived';
      return true;
    });
  }, [events, searchQuery, filterStatus]);

  return (
    <>
      {/* Floating Toast Notification (pointer-events-none so it never blocks clicks) */}
      {toastMessage ? (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[150] bg-stone-900 text-white dark:bg-white dark:text-black px-4 py-2.5 rounded-full text-xs sm:text-sm font-semibold shadow-2xl border border-stone-700 dark:border-stone-300 animate-in fade-in slide-in-from-top-2 duration-200 pointer-events-none">
          {toastMessage}
        </div>
      ) : null}

      {/* ======================================================== */}
      {/* DEDICATED NATIVE SCROLL CONTAINER FOR EVENTS TAB         */}
      {/* ======================================================== */}
      <div className="flex-1 overflow-y-auto px-4 pb-32 text-stone-900 dark:text-stone-100 relative">
        
        {/* ======================================================== */}
        {/* STICKY COMMAND AREA (Search, Filters, Refined Button)     */}
        {/* ======================================================== */}
        <div className="sticky top-0 z-40 bg-stone-50/95 dark:bg-black/95 backdrop-blur-md pb-3 pt-2 space-y-3 mb-5">
          {/* Search bar */}
          <div className="relative">
            <Search className="w-4 h-4 text-stone-400 dark:text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search events by title or category..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full min-h-[44px] pl-10 pr-10 text-sm bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-xl text-stone-900 dark:text-white placeholder:text-stone-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 dark:hover:text-zinc-300 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Segmented filter tabs */}
          <div className="flex items-center gap-1 bg-stone-200/50 dark:bg-zinc-900/50 p-1 rounded-xl w-full overflow-x-auto no-scrollbar">
            {(
              [
                { id: 'all', label: 'All', count: statusCounts.all },
                { id: 'active', label: 'Active', count: statusCounts.active },
                { id: 'upcoming', label: 'Upcoming', count: statusCounts.upcoming },
                { id: 'draft', label: 'Draft', count: statusCounts.draft },
                { id: 'ended', label: 'Ended', count: statusCounts.ended },
              ] as const
            ).map((tab) => {
              const isSelected = filterStatus === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilterStatus(tab.id)}
                  className={`text-xs sm:text-sm font-medium px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap active:scale-[0.98] cursor-pointer ${
                    isSelected
                      ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm font-semibold'
                      : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300'
                  }`}
                >
                  <span>{tab.label}</span>
                  <span
                    className={`text-[11px] px-1.5 py-0.2 rounded-full font-bold ${
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

        {/* ======================================================== */}
        {/* EVENT CARDS LIST (REDESIGNED LAYOUT)                     */}
        {/* ======================================================== */}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className="h-32 rounded-2xl bg-stone-100 dark:bg-zinc-900/60 animate-pulse border border-stone-200/50 dark:border-zinc-800/50"
              />
            ))}
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="p-8 text-center bg-white dark:bg-zinc-950 border border-dashed border-stone-200 dark:border-zinc-800 rounded-2xl">
            <Layers className="w-10 h-10 mx-auto text-stone-300 dark:text-zinc-700 mb-3" />
            <h3 className="text-base font-bold text-stone-800 dark:text-white">No Events Found</h3>
            <p className="text-xs sm:text-sm text-stone-500 dark:text-zinc-400 mt-1 max-w-sm mx-auto">
              {searchQuery
                ? 'No events match your search query.'
                : 'Get started by creating your first competition event.'}
            </p>
            <button
              type="button"
              onClick={handleOpenCreateWizard}
              className="mt-4 inline-flex items-center gap-2 min-h-[44px] px-5 bg-stone-800 hover:bg-stone-700 text-stone-100 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-100 border border-stone-700/60 rounded-xl text-xs sm:text-sm font-semibold active:scale-[0.98] transition-all cursor-pointer"
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
              const participantCount = (evt.assigned_participants || []).length;
              const judgeCount = (evt.assigned_judges || []).length;

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
                badgeDotClasses = 'bg-emerald-500 animate-pulse';
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
                  className="bg-white dark:bg-zinc-950 border border-stone-200/80 dark:border-zinc-800/80 rounded-2xl p-4 sm:p-5 shadow-sm hover:border-stone-300 dark:hover:border-zinc-700 transition-all flex flex-col justify-between group"
                >
                  <div>
                    {/* ROW 1: [CATEGORY] pill (Far Left). On Far Right: [Eye Icon] [Edit Icon] [Delete Icon] */}
                    <div className="flex items-center justify-between gap-2 mb-2.5">
                      <span className="text-xs font-semibold px-2.5 py-1 rounded-md bg-stone-100 dark:bg-zinc-900 text-stone-600 dark:text-zinc-300 border border-stone-200/50 dark:border-zinc-800/50 truncate max-w-[160px]">
                        {evt.category || 'General'}
                      </span>

                      <div className="flex items-center gap-1">
                        {/* Eye Icon to view full event dossier */}
                        <button
                          type="button"
                          onClick={() => setDossierEventId(evt.id)}
                          className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-800 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                          title="View all event details & roster"
                        >
                          <Eye className="w-4 h-4" />
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
                          className={`w-8 h-8 flex items-center justify-center rounded-lg active:scale-95 transition-all cursor-pointer ${
                            status === 'active' || status === 'ended' || status === 'archived'
                              ? 'text-zinc-300 dark:text-zinc-700 cursor-not-allowed'
                              : 'text-stone-600 hover:text-stone-900 dark:text-zinc-300 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-zinc-800'
                          }`}
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>

                        {/* Delete Event Icon */}
                        <button
                          type="button"
                          onClick={(e) => handleDeleteClick(e, evt)}
                          title={
                            status === 'active'
                              ? 'Prohibited: Event is live'
                              : hasScores
                              ? 'Archive Event (Ledger Safe)'
                              : 'Delete Event'
                          }
                          className={`w-8 h-8 flex items-center justify-center rounded-lg active:scale-95 transition-all cursor-pointer ${
                            status === 'active'
                              ? 'text-zinc-300 dark:text-zinc-700 cursor-not-allowed'
                              : hasScores
                              ? 'text-amber-500 hover:text-amber-600 hover:bg-amber-500/10'
                              : 'text-stone-400 hover:text-red-500 hover:bg-red-500/10'
                          }`}
                        >
                          {hasScores ? <Archive className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
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
                    {!hasParticipants && !isLive && !isEnded && !isPaused ? (
                      <button
                        type="button"
                        onClick={() => {
                          setActiveParticipantsEventId(evt.id);
                          setParticipantSearch('');
                          setIsEnrollDrawerOpen(true);
                        }}
                        className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold border border-emerald-600 flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer shadow-xs"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        <span>+ Add Participants</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setActiveParticipantsEventId(evt.id);
                          setParticipantSearch('');
                          setIsEnrollDrawerOpen(false);
                        }}
                        className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-850 text-stone-800 dark:text-zinc-200 text-xs font-bold border border-stone-200/80 dark:border-zinc-800 flex items-center gap-2 transition-all active:scale-95 cursor-pointer shadow-xs"
                      >
                        <Users className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                        <span>Participants {String(participantCount).padStart(2, '0')}</span>
                      </button>
                    )}

                    {/* Judges Button */}
                    {!hasJudges && !isLive && !isEnded && !isPaused ? (
                      <button
                        type="button"
                        onClick={() => {
                          setActiveJudgesEventId(evt.id);
                          setJudgeSearch('');
                          setIsAssignJudgeDrawerOpen(true);
                        }}
                        className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold border border-emerald-600 flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer shadow-xs"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>+ Add Judges</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setActiveJudgesEventId(evt.id);
                          setJudgeSearch('');
                          setIsAssignJudgeDrawerOpen(false);
                        }}
                        className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-850 text-stone-800 dark:text-zinc-200 text-xs font-bold border border-stone-200/80 dark:border-zinc-800 flex items-center gap-2 transition-all active:scale-95 cursor-pointer shadow-xs"
                      >
                        <Gavel className="w-3.5 h-3.5 text-amber-500" />
                        <span>Judges {String(judgeCount).padStart(2, '0')}</span>
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
      {/* FULL-SCREEN CREATE / EDIT EVENT PAGE (Framer-grade UI)    */}
      {/* ======================================================== */}
      {isWizardOpen ? (
        <div className="fixed inset-0 z-[120] bg-stone-50 dark:bg-black overflow-y-auto animate-in fade-in duration-200 flex flex-col pointer-events-auto">
          {/* 1. Ultra-Minimal Header */}
          <div className="sticky top-0 z-30 bg-stone-50/95 dark:bg-black/95 backdrop-blur-md border-b border-stone-200 dark:border-zinc-800 px-4 py-3.5 flex items-center justify-between shrink-0">
            {/* Top Left: Red [ Cancel ] button */}
            <button
              type="button"
              onClick={handleCloseWizard}
              className="min-h-[38px] px-4 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 border border-rose-500/20 text-xs sm:text-sm font-bold active:scale-95 transition-all cursor-pointer"
            >
              Cancel
            </button>

            <span className="text-[11px] font-mono uppercase tracking-wider font-bold text-zinc-400">
              {editingEventId ? 'Edit Event' : 'New Event'}
            </span>

            {/* Top Right: Green [ Save ] button */}
            <button
              type="button"
              disabled={!isFormValid || isSubmitting}
              onClick={handleSaveEvent}
              className="min-h-[38px] px-5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs sm:text-sm font-bold active:scale-95 transition-all disabled:opacity-40 shadow-xs cursor-pointer"
            >
              {isSubmitting ? 'Saving...' : 'Save'}
            </button>
          </div>

          {/* Scrollable Page Body */}
          <div className="flex-1 max-w-2xl w-full mx-auto px-4 py-6 space-y-8">
            {/* Draft Recovery Banner */}
            {showDraftBanner && cachedDraft && !editingEventId && (
              <div className="p-3.5 bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 text-emerald-800 dark:text-emerald-300 rounded-2xl text-xs sm:text-sm font-medium flex flex-wrap items-center justify-between gap-2 animate-in fade-in">
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
                    className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold active:scale-95 transition-all cursor-pointer"
                  >
                    Resume Draft
                  </button>
                  <button
                    type="button"
                    onClick={handleDiscardDraft}
                    className="px-2.5 py-1 bg-stone-200/80 dark:bg-zinc-800 hover:bg-stone-300 text-stone-700 dark:text-zinc-300 rounded-lg text-xs font-semibold active:scale-95 transition-all cursor-pointer"
                  >
                    Start Fresh
                  </button>
                </div>
              </div>
            )}

            {/* PART 1: EVENT IDENTITY SECTION */}
            <div className="space-y-4">
              {/* Title: A massive, borderless text input (text-3xl font-black) */}
              <input
                type="text"
                placeholder="Event Title..."
                value={eventName}
                autoFocus
                onChange={(e) => {
                  setIsDirty(true);
                  setEventName(e.target.value);
                }}
                className="w-full bg-transparent border-none outline-none focus:outline-none focus:ring-0 text-3xl sm:text-4xl font-black text-stone-900 dark:text-white placeholder:text-stone-300 dark:placeholder:text-zinc-700 tracking-tight leading-tight p-0"
              />

              {/* Category: A simple text input below the title */}
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-zinc-400 mb-1.5">
                  Category
                </label>
                <input
                  type="text"
                  placeholder="e.g. Senior, Junior, Classical"
                  value={eventCategory}
                  onChange={(e) => {
                    setIsDirty(true);
                    setEventCategory(e.target.value);
                  }}
                  className="w-full bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-stone-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 placeholder:text-stone-400 dark:placeholder:text-zinc-600 font-medium transition-all"
                />
              </div>
            </div>

            {/* PART 2: THE REIMAGINED RUBRIC ENGINE */}
            <div className="space-y-4 pt-4 border-t border-stone-200/80 dark:border-zinc-800/80">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400">
                  Rubric Criteria
                </h3>
                <span className="text-[11px] font-mono text-zinc-400">
                  {rubricCriteria.length} {rubricCriteria.length === 1 ? 'criterion' : 'criteria'}
                </span>
              </div>

              {/* Vertical Stack with Auto-Renumbering on Deletion */}
              <div className="space-y-3">
                {rubricCriteria.map((item, index) => (
                  <div
                    key={item.id}
                    className="p-3.5 rounded-2xl bg-white dark:bg-zinc-950 border border-stone-200/90 dark:border-zinc-800/90 shadow-2xs space-y-2 transition-all hover:border-stone-300 dark:hover:border-zinc-700"
                  >
                    {/* Top Line: Serial Number (Left) + Criterion Name input (Center) + Distinct Red Minus button (Right) */}
                    <div className="flex items-center gap-2.5">
                      <span className="text-sm font-bold font-mono text-zinc-400 w-5 shrink-0 text-center select-none">
                        {index + 1}.
                      </span>

                      <input
                        type="text"
                        placeholder="Criterion Name (e.g. Choreography & Flow)"
                        value={item.name}
                        disabled={hasExistingScores}
                        onChange={(e) => handleUpdateCriterion(item.id, 'name', e.target.value)}
                        className="flex-1 bg-transparent border-none outline-none focus:outline-none focus:ring-0 text-sm font-semibold text-stone-900 dark:text-white placeholder:text-stone-400 dark:placeholder:text-zinc-600 p-0 disabled:opacity-60"
                      />

                      {!hasExistingScores && rubricCriteria.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRemoveCriterion(item.id)}
                          className="w-7 h-7 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 flex items-center justify-center font-bold text-base active:scale-90 transition-all cursor-pointer shrink-0"
                          title="Delete criterion"
                          aria-label={`Delete criterion ${index + 1}`}
                        >
                          −
                        </button>
                      )}
                    </div>

                    {/* Bottom Line: Left-aligned under the name: Max Marks input */}
                    <div className="pl-7 flex items-center gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                        Max Marks:
                      </span>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={item.maxMarks}
                          disabled={hasExistingScores}
                          onChange={(e) =>
                            handleUpdateCriterion(item.id, 'maxMarks', parseInt(e.target.value, 10) || 1)
                          }
                          className="w-16 min-h-[34px] text-center font-mono font-bold bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-lg text-xs sm:text-sm text-stone-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-60"
                        />
                        <span className="text-xs font-semibold text-zinc-400 font-mono">pts</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {!hasExistingScores && (
                <button
                  type="button"
                  onClick={handleAddCriterion}
                  className="w-full min-h-[44px] border border-dashed border-stone-300 dark:border-zinc-800 hover:border-emerald-500 dark:hover:border-emerald-500 rounded-2xl text-xs sm:text-sm font-bold text-zinc-600 dark:text-zinc-300 hover:text-emerald-600 dark:hover:text-emerald-400 transition-all flex items-center justify-center gap-2 cursor-pointer active:scale-[0.99] mt-3 bg-stone-50/50 dark:bg-zinc-900/30"
                >
                  <Plus className="w-4 h-4 stroke-[2.2]" />
                  <span>Add Criterion</span>
                </button>
              )}
            </div>
          </div>

          {/* PART 2.3: STICKY TOTAL BAR */}
          <div className="sticky bottom-0 z-30 bg-stone-50/95 dark:bg-black/95 backdrop-blur-md border-t border-stone-200 dark:border-zinc-800 px-4 py-3 pb-safe flex items-center justify-center shadow-xs shrink-0">
            <div className="text-xs sm:text-sm font-semibold text-stone-700 dark:text-zinc-300 flex items-center gap-1.5">
              <span>Total Marks:</span>
              <span className="font-mono font-black text-emerald-600 dark:text-emerald-400 text-sm sm:text-base">
                {totalRubricMarks} pts
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {/* Unsaved Changes In-App Confirmation Modal */}
      {isUnsavedExitModalOpen ? (
        <div className="fixed inset-0 z-[130] bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150 pointer-events-auto">
          <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-500 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-zinc-900 dark:text-white">Discard Changes?</h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">You have unsaved changes that will be lost.</p>
              </div>
            </div>
            <div className="space-y-2 pt-1">
              <button
                type="button"
                onClick={handleForceDiscardAndExit}
                className="w-full min-h-[42px] bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-2 cursor-pointer active:scale-98 transition-all"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Discard &amp; Exit</span>
              </button>
              <button
                type="button"
                onClick={() => setIsUnsavedExitModalOpen(false)}
                className="w-full min-h-[38px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 text-xs font-semibold cursor-pointer"
              >
                Keep Editing
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ======================================================== */}
      {/* FULL-SCREEN PARTICIPANTS LIST MODAL (With Strict Rules)   */}
      {/* ======================================================== */}
      {activeParticipantsModalEvent ? (
        <div className="fixed inset-0 z-[120] bg-stone-50 dark:bg-black overflow-y-auto animate-in fade-in duration-200 flex flex-col pointer-events-auto">
          {/* Header */}
          <div className="sticky top-0 z-30 bg-stone-50/95 dark:bg-black/95 backdrop-blur-md border-b border-stone-200 dark:border-zinc-800 px-4 py-3.5 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={handleCloseParticipantsModal}
                className="w-9 h-9 rounded-xl bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white transition-all cursor-pointer shrink-0"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-bold text-zinc-900 dark:text-white leading-tight truncate">
                    {activeParticipantsModalEvent.name}
                  </h2>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shrink-0">
                    {(activeParticipantsModalEvent.assigned_participants || []).length} Enrolled
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  Participant roster &amp; appearance sequence
                </p>
              </div>
            </div>

            {/* Add Participant action (Allowed when upcoming/draft OR LIVE continuing) */}
            {activeParticipantsModalEvent.status !== 'ended' && activeParticipantsModalEvent.status !== 'archived' && (
              <button
                type="button"
                onClick={() => setIsEnrollDrawerOpen(!isEnrollDrawerOpen)}
                className="min-h-[38px] px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1.5 transition-all shadow-xs cursor-pointer shrink-0"
              >
                <UserPlus className="w-3.5 h-3.5" />
                <span>Enroll</span>
              </button>
            )}
          </div>

          {/* Body */}
          <div className="flex-1 max-w-2xl w-full mx-auto px-4 py-4 pb-24 space-y-4">
            {/* Event Live / Sealed Banner */}
            {activeParticipantsModalEvent.status === 'active' ? (
              <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 text-emerald-800 dark:text-emerald-300 text-xs font-medium flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping shrink-0" />
                <span>
                  Event is Live: You can add new participants while the competition continues. Participant removals are locked.
                </span>
              </div>
            ) : activeParticipantsModalEvent.status === 'ended' || activeParticipantsModalEvent.status === 'archived' ? (
              <div className="p-3 rounded-xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 text-xs font-medium flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-zinc-500 shrink-0" />
                <span>
                  Event is Ended: Roster is permanently sealed. No participants can be added or removed.
                </span>
              </div>
            ) : null}

            {/* Search Bar */}
            <div className="relative">
              <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Filter enrolled participants by name or school..."
                value={participantSearch}
                onChange={(e) => setParticipantSearch(e.target.value)}
                className="w-full min-h-[42px] pl-9 pr-3 text-xs bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-xl text-zinc-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>

            {/* Available Participants to Enroll Drawer */}
            {isEnrollDrawerOpen && (
              <div className="p-4 rounded-2xl bg-white dark:bg-zinc-950 border border-emerald-500/40 shadow-md space-y-3 animate-in fade-in">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                    Enroll from Organization Roster
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsEnrollDrawerOpen(false)}
                    className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 p-1 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {participants.filter(
                  (p) => !(activeParticipantsModalEvent.assigned_participants || []).includes(p.id)
                ).length === 0 ? (
                  <p className="text-xs text-zinc-500 text-center py-2">
                    All registered participants in your organization are already enrolled.
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                    {participants
                      .filter(
                        (p) => !(activeParticipantsModalEvent.assigned_participants || []).includes(p.id)
                      )
                      .map((p) => (
                        <div
                          key={p.id}
                          className="flex items-center justify-between p-2.5 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200/60 dark:border-zinc-800"
                        >
                          <div className="min-w-0 pr-2">
                            <span className="text-xs font-bold text-zinc-900 dark:text-white block truncate">
                              {p.name}
                            </span>
                            <span className="text-[10px] text-zinc-500 truncate block">
                              {p.school || 'General Institution'} {p.class_or_age ? `• ${p.class_or_age}` : ''}
                            </span>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleEnrollParticipantToEvent(p.id)}
                            className="min-h-[30px] px-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold rounded-lg transition-all active:scale-95 cursor-pointer shrink-0"
                          >
                            + Add
                          </button>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}

            {/* List of Enrolled Participants (Lineup Builder) */}
            <div className="space-y-2">
              {(() => {
                const isLiveLocked = (activeParticipantsModalEvent.status || 'draft').toLowerCase() === 'active';
                const assignedIds = activeParticipantsModalEvent.assigned_participants || [];
                const participantMap = new Map(participants.map((p) => [p.id, p]));
                const enrolledList = assignedIds
                  .map((id) => participantMap.get(id))
                  .filter((p): p is SupabaseParticipant => Boolean(p));

                const isFiltering = participantSearch.trim() !== '';
                const filtered = enrolledList.filter(
                  (p) =>
                    !isFiltering ||
                    p.name.toLowerCase().includes(participantSearch.toLowerCase()) ||
                    (p.identity_id && p.identity_id.toLowerCase().includes(participantSearch.toLowerCase())) ||
                    (p.school && p.school.toLowerCase().includes(participantSearch.toLowerCase()))
                );

                if (enrolledList.length === 0) {
                  return (
                    <div className="p-8 text-center bg-white dark:bg-zinc-900 border border-dashed border-stone-200 dark:border-zinc-800 rounded-2xl shadow-sm">
                      <Users className="w-8 h-8 mx-auto text-zinc-300 dark:text-zinc-700 mb-2" />
                      <h4 className="text-sm font-bold text-zinc-800 dark:text-white">No Participants Enrolled</h4>
                      <p className="text-xs text-zinc-500 mt-1">
                        Click &quot;Enroll&quot; above to add competitors to this event.
                      </p>
                    </div>
                  );
                }

                if (filtered.length === 0) {
                  return (
                    <div className="p-6 text-center text-xs text-zinc-500">
                      No enrolled participants match your search.
                    </div>
                  );
                }

                return (
                  <>
                    {/* Active Lockout Notice */}
                    {isLiveLocked ? (
                      <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs font-semibold">
                        <Lock className="w-4 h-4 shrink-0" />
                        <span>Performance Lineup Locked — Order cannot be changed while event is live.</span>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between px-1 text-[11px] font-medium text-zinc-400 dark:text-zinc-500">
                        <span>Drag grab handle <span className="font-mono">⋮⋮</span> to reorder performance sequence</span>
                        <span>{enrolledList.length} Competitors</span>
                      </div>
                    )}

                    {filtered.map((p) => {
                      const originalIdx = enrolledList.findIndex((item) => item.id === p.id);
                      const orderSerial =
                        activeParticipantsModalEvent.participant_sl_numbers?.[p.id] ||
                        String(originalIdx + 1).padStart(2, '0');

                      const isDragging = draggedParticipantIndex === originalIdx;
                      const isDragOver = dragOverParticipantIndex === originalIdx;

                      return (
                        <div
                          key={p.id}
                          draggable={!isLiveLocked && !isFiltering}
                          onDragStart={(e) => {
                            if (isLiveLocked || isFiltering) return;
                            setDraggedParticipantIndex(originalIdx);
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', String(originalIdx));
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            if (isLiveLocked || isFiltering || draggedParticipantIndex === null) return;
                            e.dataTransfer.dropEffect = 'move';
                            if (dragOverParticipantIndex !== originalIdx) {
                              setDragOverParticipantIndex(originalIdx);
                            }
                          }}
                          onDragLeave={() => {
                            if (dragOverParticipantIndex === originalIdx) {
                              setDragOverParticipantIndex(null);
                            }
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (isLiveLocked || isFiltering || draggedParticipantIndex === null) return;
                            const from = draggedParticipantIndex;
                            const to = originalIdx;
                            setDraggedParticipantIndex(null);
                            setDragOverParticipantIndex(null);
                            if (from !== to) {
                              handleReorderParticipant(from, to);
                            }
                          }}
                          onDragEnd={() => {
                            setDraggedParticipantIndex(null);
                            setDragOverParticipantIndex(null);
                          }}
                          className={`bg-white dark:bg-zinc-900 border ${
                            isDragOver
                              ? 'border-emerald-500 ring-2 ring-emerald-500/20 bg-emerald-50/40 dark:bg-emerald-950/20'
                              : 'border-stone-200 dark:border-zinc-800'
                          } ${
                            isDragging ? 'opacity-40 scale-[0.98]' : ''
                          } shadow-sm rounded-2xl p-3.5 flex items-center justify-between gap-2.5 transition-all duration-150`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0 flex-1">
                            {/* Grab Handle: ONLY when event is NOT active */}
                            {!isLiveLocked && (
                              <div
                                className="text-stone-400 hover:text-stone-700 dark:text-zinc-500 dark:hover:text-zinc-200 cursor-grab active:cursor-grabbing p-1 -ml-1 rounded-lg hover:bg-stone-100 dark:hover:bg-zinc-800 shrink-0 touch-none transition-colors"
                                title="Drag to reorder performance lineup"
                              >
                                <GripVertical className="w-4 h-4" />
                              </div>
                            )}

                            {/* Performance Order Serial Circle */}
                            <div className="w-9 h-9 rounded-xl bg-stone-100 dark:bg-zinc-800 border border-stone-200 dark:border-zinc-700/80 flex items-center justify-center font-mono font-bold text-xs text-zinc-800 dark:text-zinc-200 shrink-0">
                              #{orderSerial}
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-bold text-zinc-900 dark:text-white truncate">
                                  {p.name}
                                </span>
                                {/* Global Identity ID badge */}
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-stone-100 dark:bg-zinc-800 text-stone-600 dark:text-zinc-300 border border-stone-200 dark:border-zinc-700/60 shrink-0">
                                  {p.identity_id || `P-${p.sl_no || '0000'}`}
                                </span>
                              </div>
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                                <span>{p.school || 'General Institution'}</span>
                                {p.class_or_age && <span>• Class/Age: {p.class_or_age}</span>}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            {/* Reorder Buttons */}
                            {!isLiveLocked && !isFiltering && (
                              <div className="flex flex-col gap-0.5 mr-1">
                                <button
                                  type="button"
                                  disabled={originalIdx === 0}
                                  onClick={() => handleReorderParticipant(originalIdx, originalIdx - 1)}
                                  title="Move earlier in lineup"
                                  className="p-1 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-stone-100 dark:hover:bg-zinc-800 disabled:opacity-20 disabled:cursor-not-allowed cursor-pointer transition-colors"
                                >
                                  <ChevronUp className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={originalIdx === enrolledList.length - 1}
                                  onClick={() => handleReorderParticipant(originalIdx, originalIdx + 1)}
                                  title="Move later in lineup"
                                  className="p-1 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-stone-100 dark:hover:bg-zinc-800 disabled:opacity-20 disabled:cursor-not-allowed cursor-pointer transition-colors"
                                >
                                  <ChevronDown className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            )}

                            {/* Remove participant button */}
                            <button
                              type="button"
                              onClick={() => handleRemoveParticipantFromEvent(p.id)}
                              title="Remove from this event"
                              className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-red-500 hover:bg-red-500/10 active:scale-95 transition-all cursor-pointer"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      ) : null}

      {/* ======================================================== */}
      {/* FULL-SCREEN JUDGES LIST MODAL (With Strict Rules)         */}
      {/* ======================================================== */}
      {activeJudgesModalEvent ? (
        <div className="fixed inset-0 z-[120] bg-stone-50 dark:bg-black overflow-y-auto animate-in fade-in duration-200 flex flex-col pointer-events-auto">
          {/* Header */}
          <div className="sticky top-0 z-30 bg-stone-50/95 dark:bg-black/95 backdrop-blur-md border-b border-stone-200 dark:border-zinc-800 px-4 py-3.5 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={handleCloseJudgesModal}
                className="w-9 h-9 rounded-xl bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white transition-all cursor-pointer shrink-0"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-bold text-zinc-900 dark:text-white leading-tight truncate">
                    {activeJudgesModalEvent.name}
                  </h2>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full font-bold uppercase tracking-wider bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 shrink-0">
                    {(activeJudgesModalEvent.assigned_judges || []).length} Judges
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  Jury credentials &amp; scoring authorization
                </p>
              </div>
            </div>

            {/* Add / Toggle Judge button */}
            {activeJudgesModalEvent.status !== 'active' &&
              activeJudgesModalEvent.status !== 'ended' &&
              activeJudgesModalEvent.status !== 'archived' && (
                <button
                  type="button"
                  onClick={() => setIsAssignJudgeDrawerOpen(!isAssignJudgeDrawerOpen)}
                  className="min-h-[38px] px-3.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold flex items-center gap-1.5 transition-all shadow-xs cursor-pointer shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Assign</span>
                </button>
              )}
          </div>

          {/* Body */}
          <div className="flex-1 max-w-2xl w-full mx-auto px-4 py-4 pb-24 space-y-4">
            {/* Event Live / Sealed Warning */}
            {activeJudgesModalEvent.status === 'active' ? (
              <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 text-amber-800 dark:text-amber-300 text-xs font-medium flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-amber-500 shrink-0" />
                <span>
                  Event is Live: Jury assignments are locked to ensure score ballot integrity.
                </span>
              </div>
            ) : activeJudgesModalEvent.status === 'ended' || activeJudgesModalEvent.status === 'archived' ? (
              <div className="p-3 rounded-xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 text-xs font-medium flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-zinc-500 shrink-0" />
                <span>
                  Event is Ended: Jury records are sealed. No judges can be modified.
                </span>
              </div>
            ) : null}

            {/* Search Bar */}
            <div className="relative">
              <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Filter judges by name or Judge ID..."
                value={judgeSearch}
                onChange={(e) => setJudgeSearch(e.target.value)}
                className="w-full min-h-[42px] pl-9 pr-3 text-xs bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-xl text-zinc-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
            </div>

            {/* Assign Unassigned Judges Drawer */}
            {isAssignJudgeDrawerOpen && (
              <div className="p-4 rounded-2xl bg-white dark:bg-zinc-950 border border-amber-500/40 shadow-md space-y-3 animate-in fade-in">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                    Assign Registered Judges
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsAssignJudgeDrawerOpen(false)}
                    className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 p-1 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {judges.filter(
                  (j) => !(activeJudgesModalEvent.assigned_judges || []).includes(j.id)
                ).length === 0 ? (
                  <p className="text-xs text-zinc-500 text-center py-2">
                    All registered judges are already assigned to this event.
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                    {judges
                      .filter(
                        (j) => !(activeJudgesModalEvent.assigned_judges || []).includes(j.id)
                      )
                      .map((j) => (
                        <div
                          key={j.id}
                          className="flex items-center justify-between p-2.5 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200/60 dark:border-zinc-800"
                        >
                          <div className="min-w-0 pr-2">
                            <span className="text-xs font-bold text-zinc-900 dark:text-white block truncate">
                              {j.name}
                            </span>
                            <span className="text-[10px] text-zinc-500 font-mono block">
                              ID: {j.judge_id || j.id.slice(0, 8)}
                            </span>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleToggleJudgeInEvent(j.id)}
                            className="min-h-[30px] px-2.5 bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-bold rounded-lg transition-all active:scale-95 cursor-pointer shrink-0"
                          >
                            Assign
                          </button>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}

            {/* List of Assigned Judges */}
            <div className="space-y-2">
              {(() => {
                const assignedIds = activeJudgesModalEvent.assigned_judges || [];
                const assignedList = judges.filter((j) => assignedIds.includes(j.id));
                const filtered = assignedList.filter(
                  (j) =>
                    judgeSearch.trim() === '' ||
                    j.name.toLowerCase().includes(judgeSearch.toLowerCase()) ||
                    (j.judge_id && j.judge_id.toLowerCase().includes(judgeSearch.toLowerCase()))
                );

                if (assignedList.length === 0) {
                  return (
                    <div className="p-8 text-center bg-white dark:bg-zinc-950 border border-dashed border-stone-200 dark:border-zinc-800 rounded-2xl">
                      <Gavel className="w-8 h-8 mx-auto text-zinc-300 dark:text-zinc-700 mb-2" />
                      <h4 className="text-sm font-bold text-zinc-800 dark:text-white">No Judges Assigned</h4>
                      <p className="text-xs text-zinc-500 mt-1">
                        Click &quot;Assign&quot; above to select judges for this event.
                      </p>
                    </div>
                  );
                }

                if (filtered.length === 0) {
                  return (
                    <div className="p-6 text-center text-xs text-zinc-500">
                      No assigned judges match your search.
                    </div>
                  );
                }

                return filtered.map((j) => (
                  <div
                    key={j.id}
                    className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800/80 rounded-2xl p-3.5 flex items-center justify-between gap-3 shadow-xs"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="w-9 h-9 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 flex items-center justify-center font-bold text-xs shrink-0">
                        ⚖️
                      </div>

                      <div className="min-w-0 flex-1">
                        <span className="text-sm font-bold text-zinc-900 dark:text-white block truncate">
                          {j.name}
                        </span>
                        <div className="flex items-center gap-2 text-[11px] text-zinc-500 font-mono mt-0.5">
                          <span>ID: {j.judge_id || j.id.slice(0, 8)}</span>
                          <span>•</span>
                          <span>PIN: {j.pin || '****'}</span>
                        </div>
                      </div>
                    </div>

                    {/* Unassign Judge Button */}
                    <button
                      type="button"
                      onClick={() => handleToggleJudgeInEvent(j.id)}
                      title="Remove judge from event"
                      className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-red-500 hover:bg-red-500/10 active:scale-95 transition-all cursor-pointer shrink-0"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ));
              })()}
            </div>
          </div>
        </div>
      ) : null}

      {/* ======================================================== */}
      {/* EVENT DOSSIER MODAL (Triggered by Eye icon)              */}
      {/* ======================================================== */}
      {dossierEvent ? (
        <div className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 animate-in fade-in duration-200 pointer-events-auto">
          <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-3xl max-w-xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in zoom-in-95">
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
                  <p className="text-[11px] text-zinc-500 font-mono">
                    {dossierEvent.category || 'General'} • Status: {dossierEvent.status?.toUpperCase()}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setDossierEventId(null)}
                className="w-8 h-8 rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Scrollable Dossier Content */}
            <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
              {/* Section 1: Rubric Schema */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold uppercase tracking-wider text-zinc-500 text-[10px]">
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
                <span className="font-bold uppercase tracking-wider text-zinc-500 text-[10px] block">
                  Jury Panel ({(dossierEvent.assigned_judges || []).length})
                </span>

                {(dossierEvent.assigned_judges || []).length === 0 ? (
                  <div className="p-3 rounded-xl bg-stone-50 dark:bg-zinc-900 text-zinc-400 text-center">
                    No judges assigned yet.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {(dossierEvent.assigned_judges || []).map((jId) => {
                      const jObj = judges.find((j) => j.id === jId);
                      return (
                        <div
                          key={jId}
                          className="p-2.5 rounded-xl border border-stone-200 dark:border-zinc-800 bg-stone-50/50 dark:bg-zinc-900/50 flex items-center justify-between"
                        >
                          <span className="font-bold text-zinc-900 dark:text-white truncate">
                            ⚖️ {jObj?.name || jId.slice(0, 8)}
                          </span>
                          <span className="text-[10px] font-mono text-zinc-400">
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
                <span className="font-bold uppercase tracking-wider text-zinc-500 text-[10px] block">
                  Enrolled Competitors ({(dossierEvent.assigned_participants || []).length})
                </span>

                {(dossierEvent.assigned_participants || []).length === 0 ? (
                  <div className="p-3 rounded-xl bg-stone-50 dark:bg-zinc-900 text-zinc-400 text-center">
                    No participants enrolled yet.
                  </div>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                    {(dossierEvent.assigned_participants || []).map((pId, idx) => {
                      const pObj = participants.find((p) => p.id === pId);
                      const serial =
                        dossierEvent.participant_sl_numbers?.[pId] ||
                        String(idx + 1).padStart(2, '0');

                      return (
                        <div
                          key={pId}
                          className="p-2 rounded-xl border border-stone-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex items-center justify-between"
                        >
                          <div className="flex items-center gap-2 truncate">
                            <span className="font-mono font-bold text-zinc-400 text-[11px]">
                              #{serial}
                            </span>
                            <span className="font-bold text-zinc-900 dark:text-white truncate">
                              {pObj?.name || 'Unknown Competitor'}
                            </span>
                          </div>
                          <span className="text-[10px] text-zinc-500 truncate max-w-[120px]">
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
            <div className="p-4 border-t border-stone-200 dark:border-zinc-800 bg-stone-50 dark:bg-zinc-900/40 flex justify-end shrink-0">
              <button
                type="button"
                onClick={() => setDossierEventId(null)}
                className="min-h-[38px] px-5 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black text-xs font-bold active:scale-95 transition-all cursor-pointer"
              >
                Close Dossier
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ======================================================== */}
      {/* CUSTOM CONFIRMATION MODAL (DELETE & DUPLICATE)           */}
      {/* ======================================================== */}
      {eventModalState && eventModalState.isOpen ? (
        <div className="fixed inset-0 z-[140] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150 pointer-events-auto">
          <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95">
            {eventModalState.type === 'delete' ? (
              <>
                <div className="flex items-center space-x-3 text-red-600 dark:text-red-400">
                  <div className="w-10 h-10 rounded-2xl bg-red-500/15 flex items-center justify-center">
                    {eventModalState.canDelete ? <Trash2 className="w-5 h-5" /> : <Archive className="w-5 h-5" />}
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-zinc-900 dark:text-white leading-tight">
                      {eventModalState.canDelete ? 'Delete Event?' : 'Archive Event?'}
                    </h3>
                    <p className="text-xs text-red-600 dark:text-red-400 font-mono">
                      {eventModalState.canDelete ? 'Permanent removal' : 'Ledger protected'}
                    </p>
                  </div>
                </div>

                <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  {eventModalState.canDelete ? (
                    <>
                      Permanently delete <strong className="text-zinc-900 dark:text-white">{eventModalState.eventName}</strong>? This action cannot be undone.
                    </>
                  ) : (
                    <>
                      Scores exist for <strong className="text-zinc-900 dark:text-white">{eventModalState.eventName}</strong>. To preserve audit and ledger integrity, this event will be archived instead of purged.
                    </>
                  )}
                </p>

                <div className="grid grid-cols-2 gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => setEventModalState(null)}
                    className="min-h-[42px] bg-stone-100 hover:bg-stone-200 dark:bg-zinc-900 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs font-bold rounded-xl active:scale-95 transition-all cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmModalAction}
                    className="min-h-[42px] bg-red-600 hover:bg-red-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-red-600/25 active:scale-95 transition-all cursor-pointer flex items-center justify-center space-x-1.5"
                  >
                    {eventModalState.canDelete ? <Trash2 className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
                    <span>{eventModalState.canDelete ? 'Delete Event' : 'Archive Event'}</span>
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
                    <p className="text-xs text-zinc-500 font-mono">
                      Create template copy
                    </p>
                  </div>
                </div>

                <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  Create an independent draft copy of <strong className="text-zinc-900 dark:text-white">{eventModalState.eventName}</strong> with all rubric criteria and roster configurations.
                </p>

                <div className="grid grid-cols-2 gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => setEventModalState(null)}
                    className="min-h-[42px] bg-stone-100 hover:bg-stone-200 dark:bg-zinc-900 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs font-bold rounded-xl active:scale-95 transition-all cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmModalAction}
                    className="min-h-[42px] bg-zinc-900 hover:bg-zinc-800 dark:bg-white dark:hover:bg-zinc-100 text-white dark:text-black text-xs font-bold rounded-xl active:scale-95 transition-all cursor-pointer flex items-center justify-center space-x-1.5 shadow-sm"
                  >
                    <Copy className="w-4 h-4" />
                    <span>Duplicate as Draft</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {/* ======================================================== */}
      {/* FLOATING ACTION BUTTON (FAB) FOR "+ CREATE EVENT"        */}
      {/* ======================================================== */}
      <button
        type="button"
        onClick={handleOpenCreateWizard}
        className="fixed bottom-24 right-6 z-50 w-14 h-14 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl shadow-xl shadow-emerald-900/30 flex items-center justify-center active:scale-95 transition-all cursor-pointer"
        aria-label="Create Event"
        title="Create Event"
      >
        <Plus className="w-6 h-6 stroke-[2.5]" />
      </button>
    </>
  );
}
