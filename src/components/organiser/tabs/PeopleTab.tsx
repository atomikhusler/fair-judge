import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as XLSX from 'xlsx';
import { QRCodeSVG } from 'qrcode.react';
import { 
  Users, 
  Upload, 
  Download, 
  Plus, 
  Trash2, 
  Search, 
  FileSpreadsheet, 
  Check, 
  AlertCircle, 
  CheckCircle2, 
  X,
  Edit2,
  Gavel,
  Copy,
  Printer,
  Sliders,
  Phone,
  GraduationCap,
  Building,
  QrCode,
  Share2,
  HelpCircle,
  Settings,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Scale,
  Eye
} from 'lucide-react';
import { dbService, subscribeToDatabase, generateUUID } from '../../../lib/supabase';
import { eventBus } from '../../../lib/eventBus';
import { 
  Organization, 
  SupabaseParticipant, 
  SupabaseJudge, 
  CustomParticipantField,
  SupabaseEvent
} from '../../../lib/supabaseTypes';

// ========================================================
// ALGORITHM #5: LEVENSHTEIN DISTANCE & FUZZY MATCH ENGINE
// ========================================================
function levenshteinDistance(s1: string, s2: string): number {
  const a = s1.toLowerCase().trim();
  const b = s2.toLowerCase().trim();
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );

  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return matrix[a.length][b.length];
}

function calculateSimilarity(s1: string, s2: string): number {
  const a = s1.toLowerCase().trim();
  const b = s2.toLowerCase().trim();
  if (a === b) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(a, b);
  return 1.0 - dist / maxLen;
}

// Canonical Aliases for Fuzzy Auto-Mapping
const FIELD_ALIASES = {
  name: [
    'name',
    'full name',
    'student name',
    'participant',
    'participant name',
    'competitor',
    'candidate',
    'competitor name',
  ],
  school: [
    'school',
    'school name',
    'institution',
    'institution name',
    'college',
    'academy',
    'team',
    'organization',
    'affiliation',
  ],
  class_or_age: [
    'class',
    'class/age',
    'grade',
    'standard',
    'age',
    'age group',
    'division',
    'category',
    'year',
  ],
  mobile: [
    'mobile',
    'mobile number',
    'contact',
    'contact no',
    'contact number',
    'phone',
    'phone number',
    'cell',
    'whatsapp',
    'tel',
  ],
};

function matchHeaderToField(header: string, customFields: CustomParticipantField[]): {
  field: 'name' | 'school' | 'class_or_age' | 'mobile' | string | null;
  confidence: number;
} {
  const cleanHeader = header.toLowerCase().replace(/[^a-z0-9 ]/gi, ' ').trim();

  // 1. Check Standard Fields
  let bestField: 'name' | 'school' | 'class_or_age' | 'mobile' | string | null = null;
  let bestScore = 0;

  for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      if (cleanHeader === alias) {
        return { field: key, confidence: 1.0 };
      }
      const sim = calculateSimilarity(cleanHeader, alias);
      if (sim > bestScore) {
        bestScore = sim;
        bestField = key;
      }
    }
  }

  // 2. Check Custom Fields
  for (const cf of customFields) {
    const cfName = cf.name.toLowerCase().trim();
    if (cleanHeader === cfName) {
      return { field: cf.id, confidence: 1.0 };
    }
    const sim = calculateSimilarity(cleanHeader, cfName);
    if (sim > bestScore) {
      bestScore = sim;
      bestField = cf.id;
    }
  }

  // Threshold: >= 70% confidence matches
  if (bestScore >= 0.70) {
    return { field: bestField, confidence: bestScore };
  }

  return { field: null, confidence: bestScore };
}

// Generate 5-character alphanumeric Judge ID: "J-XXXX"
function generateJudgeId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let randomPart = '';
  for (let i = 0; i < 4; i++) {
    randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `J-${randomPart}`;
}

// Generate 4-digit numeric PIN
function generateJudgePin(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

interface StagedParticipant {
  id: string;
  name: string;
  school: string;
  class_or_age: string;
  mobile_number: string;
  custom_values: Record<string, string>;
  isValid: boolean;
  validationError?: string;
}

interface PeopleTabProps {
  organization: Organization;
}

export function PeopleTab({ organization }: PeopleTabProps) {
  const [activeSubTab, setActiveSubTab] = useState<'participants' | 'judges'>('participants');

  // Dynamic Categorization Header Preference: 'Class/Grade' vs 'Age Group'
  const categoryStorageKey = useMemo(
    () => `fj_category_preference_${organization.org_id.toUpperCase()}`,
    [organization.org_id]
  );

  const [categoryLabel, setCategoryLabel] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(categoryStorageKey);
      if (stored) return stored;
    } catch {}
    return 'Class/Grade';
  });

  const [showCategoryPrompt, setShowCategoryPrompt] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(categoryStorageKey);
      return stored === null;
    } catch {
      return false;
    }
  });

  const [isEditingCategoryLabel, setIsEditingCategoryLabel] = useState(false);
  const [customCategoryInput, setCustomCategoryInput] = useState('');
  const [showColumnsConfig, setShowColumnsConfig] = useState(false);

  const handleSelectCategoryPreference = (pref: string) => {
    setCategoryLabel(pref);
    try {
      localStorage.setItem(categoryStorageKey, pref);
    } catch {}
    setShowCategoryPrompt(false);
    setIsEditingCategoryLabel(false);
  };

  // Participants State (Optimistically seeded from local cache)
  const [participants, setParticipants] = useState<SupabaseParticipant[]>(() =>
    dbService.getCachedParticipants(organization.org_id)
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [uploadNotice, setUploadNotice] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  // Staging Preview State for Excel Import
  const [stagedRows, setStagedRows] = useState<StagedParticipant[]>([]);
  const [showStagingModal, setShowStagingModal] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  // Add / Edit Participant Modal
  const [showParticipantModal, setShowParticipantModal] = useState(false);
  const [editingParticipant, setEditingParticipant] = useState<SupabaseParticipant | null>(null);
  const [participantForm, setParticipantForm] = useState({
    name: '',
    school: '',
    class_or_age: '',
    mobile_number: '',
    custom_values: {} as Record<string, string>,
  });

  // Judges State (Optimistically seeded from local cache)
  const [judges, setJudges] = useState<SupabaseJudge[]>(() =>
    dbService.getCachedJudges(organization.org_id)
  );
  const [events, setEvents] = useState<SupabaseEvent[]>(() =>
    dbService.getCachedEvents(organization.org_id)
  );
  const [showJudgeModal, setShowJudgeModal] = useState(false);
  const [editingJudge, setEditingJudge] = useState<SupabaseJudge | null>(null);
  const [judgeForm, setJudgeForm] = useState({
    name: '',
    judge_id: '',
    pin: '',
  });
  const [copiedJudgePin, setCopiedJudgePin] = useState<string | null>(null);

  // Show QR Modal State
  const [selectedJudgeForQr, setSelectedJudgeForQr] = useState<SupabaseJudge | null>(null);
  const [showQrModal, setShowQrModal] = useState(false);

  // Judge Dossier / Details Modal State
  const [selectedJudgeForDetails, setSelectedJudgeForDetails] = useState<SupabaseJudge | null>(null);
  const [showJudgeDetailsModal, setShowJudgeDetailsModal] = useState(false);

  // Custom Framer-Style Delete Confirmation Modal State
  const [deleteModalState, setDeleteModalState] = useState<{
    isOpen: boolean;
    type: 'participant' | 'judge';
    id: string;
    name: string;
  } | null>(null);

  const [customFields, setCustomFields] = useState<CustomParticipantField[]>(
    organization.custom_participant_fields || []
  );

  useEffect(() => {
    setCustomFields(organization.custom_participant_fields || []);
  }, [organization.custom_participant_fields]);

  // Pure Event-Driven Architecture: Subscribe to eventBus cache updates with zero-flash hydration
  useEffect(() => {
    const unsubBus = eventBus.on('cache_updated', (payload) => {
      const table = payload?.table;
      if (!table || table === 'participants' || table === 'all') {
        setParticipants(dbService.getCachedParticipants(organization.org_id));
      }
      if (!table || table === 'judges' || table === 'all') {
        setJudges(dbService.getCachedJudges(organization.org_id));
      }
      if (!table || table === 'events' || table === 'all') {
        setEvents(dbService.getCachedEvents(organization.org_id));
      }
    });

    // Quiet SWR background verification (checks 5-minute TTL without blocking or showing loaders)
    dbService.getParticipants(organization.org_id);
    dbService.getJudges(organization.org_id);
    dbService.getEvents(organization.org_id);

    return () => unsubBus();
  }, [organization.org_id]);

  const refreshFromCache = useCallback(() => {
    setParticipants(dbService.getCachedParticipants(organization.org_id));
    setJudges(dbService.getCachedJudges(organization.org_id));
    setEvents(dbService.getCachedEvents(organization.org_id));
  }, [organization.org_id]);
  const loadData = refreshFromCache;

  // ========================================================
  // CUSTOM HEADERS MANAGEMENT (Delete/Remove Custom Headers)
  // ========================================================
  const handleDeleteCustomField = async (fieldId: string, fieldName: string) => {
    const confirmed = window.confirm(`Remove custom field "${fieldName}" from participants?`);
    if (!confirmed) return;

    const updated = customFields.filter((cf) => cf.id !== fieldId);
    setCustomFields(updated);
    try {
      await dbService.updateOrganization(organization.org_id, {
        custom_participant_fields: updated,
      });
      setUploadNotice({ type: 'success', msg: `Removed custom header "${fieldName}".` });
      setTimeout(() => setUploadNotice(null), 3000);
    } catch (err) {
      console.error('Failed to delete custom header:', err);
    }
  };

  // ========================================================
  // PART 2: SMART .XLSX TEMPLATE GENERATOR
  // ========================================================
  const handleDownloadTemplate = () => {
    // Exact schema matching dynamic model
    const headers = [
      'Full Name (Mandatory)',
      'School / Institution (Mandatory)',
      `${categoryLabel} (Optional)`,
      'Mobile Number (Optional)',
      ...customFields.map((f) => `${f.name} (Optional)`),
    ];

    const sampleRow1 = [
      'Aarav Sharma',
      'Modern High School',
      categoryLabel.toLowerCase().includes('age') ? '14-16 Yrs' : 'Grade 10',
      '9876543210',
      ...customFields.map(() => 'Sample Value'),
    ];

    const sampleRow2 = [
      'Priya Patel',
      'St. Jude Academy',
      categoryLabel.toLowerCase().includes('age') ? '11-13 Yrs' : 'Grade 8',
      '9812345678',
      ...customFields.map(() => 'Sample Value'),
    ];

    const wsData = [headers, sampleRow1, sampleRow2];
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Apply column widths for pristine usability
    ws['!cols'] = [
      { wch: 26 }, // Full Name
      { wch: 30 }, // School / Institution
      { wch: 22 }, // Category
      { wch: 22 }, // Mobile
      ...customFields.map(() => ({ wch: 20 })),
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Participants');
    XLSX.writeFile(wb, `FairJudge_Roster_Template_${organization.org_id}.xlsx`);
  };

  // Export current participants roster with Participant ID
  const handleExportParticipantsExcel = () => {
    if (participants.length === 0) {
      alert('No participants found to export.');
      return;
    }

    const rows = participants.map((p, idx) => {
      const rowData: Record<string, any> = {
        'Sl. No': idx + 1,
        'Participant ID': p.identity_id || `P-${p.sl_no || idx + 1}`,
        'Full Name': p.name,
        'School / Institution': p.school,
        [categoryLabel]: p.class_or_age || '',
        'Mobile Number': p.mobile_number || '',
      };

      customFields.forEach((cf) => {
        rowData[cf.name] = (p.custom_values && p.custom_values[cf.id]) || '';
      });

      return rowData;
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
      { wch: 10 },
      { wch: 18 },
      { wch: 26 },
      { wch: 30 },
      { wch: 20 },
      { wch: 20 },
      ...customFields.map(() => ({ wch: 20 })),
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Participants');
    XLSX.writeFile(wb, `FairJudge_Participants_${organization.org_id}.xlsx`);
  };

  // ========================================================
  // PART 2: STRICT .XLSX PARSER WITH FUZZY MATCH & STAGING
  // ========================================================
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Strict Excel Check: only .xlsx accepted
    const fileName = file.name.toLowerCase();
    if (!fileName.endsWith('.xlsx')) {
      alert('Strict Excel Policy: Please upload a valid .xlsx file. CSV and legacy formats are not supported.');
      if (e.target) e.target.value = '';
      return;
    }

    setUploadNotice(null);

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        const firstSheetName = wb.SheetNames[0];
        if (!firstSheetName) {
          throw new Error('Spreadsheet has no worksheets.');
        }

        const ws = wb.Sheets[firstSheetName];
        const data: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });

        if (!data || data.length < 2) {
          throw new Error('Spreadsheet must contain at least 1 header row and 1 participant data row.');
        }

        const rawHeaders: string[] = data[0].map((h: any) => String(h || '').trim());

        // Map column indices using Levenshtein distance
        let nameIdx = -1;
        let schoolIdx = -1;
        let categoryIdx = -1;
        let mobileIdx = -1;
        const customColMap: Record<string, number> = {};

        rawHeaders.forEach((h, colIdx) => {
          if (!h) return;
          const match = matchHeaderToField(h, customFields);
          if (match.field === 'name' && nameIdx === -1) {
            nameIdx = colIdx;
          } else if (match.field === 'school' && schoolIdx === -1) {
            schoolIdx = colIdx;
          } else if (match.field === 'class_or_age' && categoryIdx === -1) {
            categoryIdx = colIdx;
          } else if (match.field === 'mobile' && mobileIdx === -1) {
            mobileIdx = colIdx;
          } else if (match.field && customFields.some((cf) => cf.id === match.field)) {
            customColMap[match.field] = colIdx;
          }
        });

        // Fail-safe fallback checks if headers had no direct hit
        if (nameIdx === -1) {
          nameIdx = rawHeaders.findIndex((h) => /name|participant|student/i.test(h));
        }
        if (schoolIdx === -1) {
          schoolIdx = rawHeaders.findIndex((h) => /school|institution|college|team|org/i.test(h));
        }

        if (nameIdx === -1) {
          throw new Error('Could not recognize a "Full Name" column. Please check your headers.');
        }

        const staged: StagedParticipant[] = [];

        for (let i = 1; i < data.length; i++) {
          const row = data[i];
          if (!row || row.length === 0) continue;

          const nameVal = nameIdx !== -1 && row[nameIdx] !== undefined ? String(row[nameIdx]).trim() : '';
          const schoolVal = schoolIdx !== -1 && row[schoolIdx] !== undefined ? String(row[schoolIdx]).trim() : '';
          const catVal = categoryIdx !== -1 && row[categoryIdx] !== undefined ? String(row[categoryIdx]).trim() : '';
          const mobVal = mobileIdx !== -1 && row[mobileIdx] !== undefined ? String(row[mobileIdx]).trim() : '';

          // If completely empty row, skip
          if (!nameVal && !schoolVal && !catVal && !mobVal) continue;

          const customVals: Record<string, string> = {};
          customFields.forEach((cf) => {
            const cIdx = customColMap[cf.id];
            if (cIdx !== undefined && row[cIdx] !== undefined) {
              customVals[cf.id] = String(row[cIdx]).trim();
            }
          });

          // Mandatory validation: Name and School
          const hasName = Boolean(nameVal);
          const hasSchool = Boolean(schoolVal);
          const isValid = hasName && hasSchool;
          let validationError = '';
          if (!hasName && !hasSchool) {
            validationError = 'Missing Name and School';
          } else if (!hasName) {
            validationError = 'Missing Full Name';
          } else if (!hasSchool) {
            validationError = 'Missing School / Institution';
          }

          staged.push({
            id: generateUUID(),
            name: nameVal,
            school: schoolVal || 'General',
            class_or_age: catVal,
            mobile_number: mobVal,
            custom_values: customVals,
            isValid,
            validationError,
          });
        }

        if (staged.length === 0) {
          throw new Error('No participant rows found in uploaded Excel file.');
        }

        setStagedRows(staged);
        setShowStagingModal(true);
      } catch (err: any) {
        setUploadNotice({
          type: 'error',
          msg: err.message || 'Failed to process .xlsx file.',
        });
      } finally {
        if (e.target) e.target.value = '';
      }
    };
    reader.readAsBinaryString(file);
  };

  // Confirm Staged Import
  const handleConfirmImport = async () => {
    const validRows = stagedRows.filter((r) => r.isValid);
    if (validRows.length === 0) {
      alert('There are no valid rows to import. Please fix or remove invalid rows.');
      return;
    }

    setIsImporting(true);
    try {
      const rowsToSave = validRows.map((r) => ({
        name: r.name,
        school: r.school,
        class_or_age: r.class_or_age,
        mobile_number: r.mobile_number,
        custom_values: r.custom_values,
      }));

      const importedCount = await dbService.bulkCreateParticipants(organization.org_id, rowsToSave);
      setShowStagingModal(false);
      setStagedRows([]);
      setUploadNotice({
        type: 'success',
        msg: `Successfully imported ${importedCount} participants!`,
      });
      await loadData();
    } catch (err: any) {
      console.error('Import failed:', err);
      alert(err.message || 'Failed to finalize import.');
    } finally {
      setIsImporting(false);
    }
  };

  const handleRemoveStagedRow = (rowId: string) => {
    setStagedRows((prev) => prev.filter((r) => r.id !== rowId));
  };

  // ========================================================
  // MANUAL PARTICIPANT ACTIONS (Add / Edit / Delete)
  // ========================================================
  const handleOpenAddParticipant = () => {
    setEditingParticipant(null);
    setParticipantForm({
      name: '',
      school: '',
      class_or_age: '',
      mobile_number: '',
      custom_values: {},
    });
    setShowParticipantModal(true);
  };

  const handleOpenEditParticipant = (p: SupabaseParticipant) => {
    setEditingParticipant(p);
    setParticipantForm({
      name: p.name,
      school: p.school || '',
      class_or_age: p.class_or_age || '',
      mobile_number: p.mobile_number || '',
      custom_values: p.custom_values || {},
    });
    setShowParticipantModal(true);
  };

  const handleSaveParticipant = async () => {
    if (!participantForm.name.trim()) {
      alert('Full Name is required.');
      return;
    }
    if (!participantForm.school.trim()) {
      alert('School / Institution is required.');
      return;
    }

    try {
      if (editingParticipant) {
        await dbService.updateParticipant(editingParticipant.id, {
          name: participantForm.name.trim(),
          school: participantForm.school.trim(),
          class_or_age: participantForm.class_or_age.trim(),
          mobile_number: participantForm.mobile_number.trim(),
          custom_values: participantForm.custom_values,
        });
      } else {
        await dbService.createParticipant(organization.org_id, {
          name: participantForm.name.trim(),
          school: participantForm.school.trim(),
          class_or_age: participantForm.class_or_age.trim(),
          mobile_number: participantForm.mobile_number.trim(),
          custom_values: participantForm.custom_values,
        });
      }
      setShowParticipantModal(false);
      await loadData();
    } catch (err) {
      console.error('Failed to save participant:', err);
    }
  };

  const promptDeleteParticipant = (pId: string, name: string) => {
    setDeleteModalState({
      isOpen: true,
      type: 'participant',
      id: pId,
      name,
    });
  };

  const promptDeleteJudge = (jId: string, name: string) => {
    setDeleteModalState({
      isOpen: true,
      type: 'judge',
      id: jId,
      name,
    });
  };

  const handleConfirmDelete = async () => {
    if (!deleteModalState) return;
    const { type, id } = deleteModalState;
    try {
      if (type === 'participant') {
        await dbService.deleteParticipant(id);
      } else {
        await dbService.deleteJudge(id);
      }
      await loadData();
    } catch (err) {
      console.error('Failed to delete roster record:', err);
    } finally {
      setDeleteModalState(null);
    }
  };

  // ========================================================
  // PART 2: JUDGE PROVISIONING ACTIONS (Add / Edit / Delete)
  // ========================================================
  const handleOpenAddJudge = () => {
    setEditingJudge(null);
    setJudgeForm({
      name: '',
      judge_id: generateJudgeId(),
      pin: generateJudgePin(),
    });
    setShowJudgeModal(true);
  };

  const handleOpenEditJudge = (j: SupabaseJudge) => {
    setEditingJudge(j);
    setJudgeForm({
      name: j.name,
      judge_id: j.judge_id || j.id.slice(0, 6),
      pin: j.pin,
    });
    setShowJudgeModal(true);
  };

  const handleSaveJudge = async () => {
    if (!judgeForm.name.trim()) {
      alert('Judge Full Name is required.');
      return;
    }
    if (!judgeForm.judge_id.trim()) {
      alert('Judge ID Code is required.');
      return;
    }
    if (!judgeForm.pin.trim() || judgeForm.pin.trim().length < 4) {
      alert('A valid 4-Digit PIN is required.');
      return;
    }

    try {
      if (editingJudge) {
        await dbService.updateJudge(editingJudge.id, {
          name: judgeForm.name.trim(),
          judge_id: judgeForm.judge_id.trim().toUpperCase(),
          pin: judgeForm.pin.trim(),
        });
      } else {
        await dbService.createJudge(
          organization.org_id,
          judgeForm.name.trim(),
          judgeForm.pin.trim(),
          judgeForm.judge_id.trim().toUpperCase()
        );
      }
      setShowJudgeModal(false);
      await loadData();
    } catch (err) {
      console.error('Failed to save judge:', err);
    }
  };

  // QR Code Payload Builder (1-Tap Login)
  const getJudgeQrPayload = (j: SupabaseJudge) => {
    return JSON.stringify({
      orgId: organization.org_id,
      judgeId: j.judge_id || j.id,
      pin: j.pin,
    });
  };

  // Show / Share QR Modal
  const handleOpenQrModal = (j: SupabaseJudge) => {
    setSelectedJudgeForQr(j);
    setShowQrModal(true);
  };

  const handleNativeShareJudge = async (j: SupabaseJudge) => {
    const shareData = {
      title: `Fair Judge Credentials - ${j.name}`,
      text: `Fair Judge Login Credentials:\nOrganization ID: ${organization.org_id}\nJudge ID: ${j.judge_id || j.id}\nPIN: ${j.pin}\n\nScan QR or enter PIN on the Fair Judge terminal to start scoring.`,
    };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch {
        // User cancelled or share failed
      }
    } else {
      navigator.clipboard.writeText(shareData.text);
      alert('Credentials copied to clipboard!');
    }
  };

  // ========================================================
  // PART 5: ROBUST STANDALONE BADGE PRINT ENGINE (window.open)
  // ========================================================
  const handleTriggerPrint = () => {
    if (judges.length === 0) {
      alert('No judges found to print badges for.');
      return;
    }

    const escapeHtml = (str: string) =>
      String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const badgesHtml = judges
      .map((j) => {
        const qrPayload = getJudgeQrPayload(j);
        const qrSvgString = renderToStaticMarkup(
          <QRCodeSVG value={qrPayload} size={128} level="M" />
        );

        return `
          <div class="badge-card">
            <div>
              <div class="badge-header">
                <span class="org-name">${escapeHtml(organization.name)}</span>
                <h3 class="judge-name">${escapeHtml(j.name)}</h3>
                <p class="judge-role">Official Evaluator / Judge</p>
              </div>

              <div class="qr-box">
                <div class="qr-container">
                  ${qrSvgString}
                </div>
              </div>
              <p class="qr-sub">Scan with terminal camera for 1-tap authentication</p>
            </div>

            <div>
              <div class="cred-strip">
                <div class="cred-col">
                  <span class="cred-label">Judge ID Code</span>
                  <span class="cred-val">${escapeHtml(j.judge_id || j.id.slice(0, 6))}</span>
                </div>
                <div class="cred-col">
                  <span class="cred-label">4-Digit PIN</span>
                  <span class="cred-val pin">${escapeHtml(j.pin)}</span>
                </div>
              </div>

              <div class="badge-footer">
                <span class="brand">⚖️ FAIR JUDGE</span>
                <span class="sys">Competition Systems</span>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    const htmlDocument = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(organization.name)} - Official Judge Credentials</title>
        <style>
          @page { size: A4 portrait; margin: 12mm; }
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background: #ffffff !important;
            color: #09090b !important;
            padding: 16px;
          }
          .header {
            text-align: center;
            border-bottom: 2px solid #18181b;
            padding-bottom: 10px;
            margin-bottom: 20px;
          }
          .header h1 {
            font-size: 20px;
            font-weight: 900;
            text-transform: uppercase;
            letter-spacing: 0.05em;
          }
          .header p {
            font-size: 11px;
            font-family: monospace;
            color: #71717a;
            margin-top: 2px;
          }
          .badge-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 16px;
          }
          .badge-card {
            border: 2px solid #18181b;
            border-radius: 16px;
            padding: 16px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            background: #ffffff;
            break-inside: avoid;
            page-break-inside: avoid;
            min-height: 310px;
          }
          .badge-header {
            text-align: center;
            border-bottom: 1px solid #e4e4e7;
            padding-bottom: 8px;
          }
          .org-name {
            font-size: 10px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            color: #71717a;
            display: block;
          }
          .judge-name {
            font-size: 17px;
            font-weight: 900;
            color: #09090b;
            margin-top: 4px;
            text-transform: uppercase;
          }
          .judge-role {
            font-size: 9px;
            color: #71717a;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            font-weight: 600;
            margin-top: 2px;
          }
          .qr-box {
            display: flex;
            justify-content: center;
            margin: 12px 0 6px 0;
          }
          .qr-container {
            padding: 8px;
            border: 1px solid #e4e4e7;
            border-radius: 12px;
            background: #ffffff;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .qr-sub {
            font-size: 9px;
            text-align: center;
            color: #71717a;
            font-weight: 500;
            margin-bottom: 6px;
          }
          .cred-strip {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            background: #f4f4f5;
            padding: 8px;
            border-radius: 10px;
            text-align: center;
            margin-top: 4px;
          }
          .cred-col {}
          .cred-label {
            font-size: 8px;
            font-weight: 700;
            color: #71717a;
            text-transform: uppercase;
            display: block;
          }
          .cred-val {
            font-size: 13px;
            font-family: monospace;
            font-weight: 900;
            color: #18181b;
          }
          .cred-val.pin {
            color: #059669;
          }
          .badge-footer {
            margin-top: 10px;
            padding-top: 8px;
            border-top: 1px solid #e4e4e7;
            display: flex;
            justify-content: space-between;
            font-size: 9px;
            color: #71717a;
            font-weight: 600;
          }
          .brand {
            font-weight: 900;
            color: #09090b;
          }
          .sys {
            font-family: monospace;
            font-size: 8px;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>${escapeHtml(organization.name)}</h1>
          <p>Official Judge Credentials & Badges • Org ID: ${escapeHtml(organization.org_id)}</p>
        </div>
        <div class="badge-grid">
          ${badgesHtml}
        </div>
      </body>
      </html>
    `;

    const printWin = window.open('', '_blank');
    if (printWin) {
      printWin.document.write(htmlDocument);
      printWin.document.close();
      printWin.focus();
      setTimeout(() => {
        printWin.print();
      }, 250);
    }
  };

  // Filtered lists
  const filteredParticipants = useMemo(() => {
    return participants.filter(
      (p) =>
        searchQuery === '' ||
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.school.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (p.class_or_age && p.class_or_age.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (p.mobile_number && p.mobile_number.includes(searchQuery))
    );
  }, [participants, searchQuery]);

  const filteredJudges = useMemo(() => {
    return judges.filter(
      (j) =>
        searchQuery === '' ||
        j.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (j.judge_id && j.judge_id.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (j.pin && j.pin.includes(searchQuery))
    );
  }, [judges, searchQuery]);

  return (
    <>
      {/* ======================================================== */}
      {/* ======================================================== */}
      {/* PART 3: PRINTABLE BADGES COMPONENT (Strictly Print Only) */}
      {/* ======================================================== */}
      <div className="hidden print:block bg-white text-black p-4 w-full">
        <div className="mb-4 text-center border-b pb-2">
          <h1 className="text-xl font-black uppercase tracking-wider text-black">
            {organization.name}
          </h1>
          <p className="text-xs text-zinc-700 font-mono">
            Official Judge Credentials & Badges • Org ID: {organization.org_id}
          </p>
        </div>

        {/* 4 to 6 ID Cards per A4 Page Grid */}
        <div className="grid grid-cols-2 gap-4">
          {judges.map((j) => {
            const qrPayload = getJudgeQrPayload(j);
            return (
              <div
                key={j.id}
                className="border-2 border-zinc-900 rounded-2xl p-4 flex flex-col justify-between bg-white text-black break-inside-avoid page-break-inside-avoid min-h-[300px]"
              >
                <div>
                  {/* Top: Organisation Name */}
                  <div className="text-center border-b border-zinc-200 pb-2">
                    <span className="text-[11px] font-black uppercase tracking-widest text-zinc-600 block">
                      {organization.name}
                    </span>
                    {/* Judge Name printed directly under Organisation Name */}
                    <h3 className="text-lg font-black text-center text-zinc-950 mt-1 uppercase tracking-tight">
                      {j.name}
                    </h3>
                    <p className="text-[10px] text-zinc-500 text-center uppercase tracking-wider font-semibold">
                      Official Evaluator / Judge
                    </p>
                  </div>

                  {/* Centered Large QR Code */}
                  <div className="flex justify-center my-3">
                    <div className="p-2 border border-zinc-300 rounded-xl bg-white shadow-xs">
                      <QRCodeSVG value={qrPayload} size={128} level="M" />
                    </div>
                  </div>
                  <p className="text-[9px] text-center text-zinc-500 font-medium">
                    Scan with terminal camera for 1-tap authentication
                  </p>
                </div>

                <div>
                  {/* Manual Backup Credentials Strip */}
                  <div className="mt-2 pt-2 border-t border-zinc-200 grid grid-cols-2 gap-2 text-center bg-zinc-50 p-1.5 rounded-lg">
                    <div>
                      <span className="text-[8px] text-zinc-500 uppercase block font-bold">
                        Judge ID Code
                      </span>
                      <span className="text-xs font-mono font-black text-zinc-900">
                        {j.judge_id || j.id.slice(0, 6)}
                      </span>
                    </div>
                    <div>
                      <span className="text-[8px] text-zinc-500 uppercase block font-bold">
                        4-Digit PIN
                      </span>
                      <span className="text-xs font-mono font-black text-emerald-700">
                        {j.pin}
                      </span>
                    </div>
                  </div>

                  {/* Bottom: App Logo & App Name + Developer Branding */}
                  <div className="mt-2.5 pt-2 border-t border-zinc-200 flex items-center justify-between text-[9px] text-zinc-600">
                    <div className="flex items-center space-x-1.5 font-bold text-zinc-900">
                      <div className="w-3.5 h-3.5 rounded bg-zinc-900 text-white flex items-center justify-center">
                        <Scale className="w-2.5 h-2.5" />
                      </div>
                      <span className="uppercase tracking-wider font-black">Fair Judge</span>
                    </div>
                    <span className="text-[8px] font-mono text-zinc-500">
                      Fair Judge Competition Systems
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ======================================================== */}
      {/* SCREEN UI VIEW (Natural Native Scroll & Sticky Nav)      */}
      {/* ======================================================== */}
      <div className="print:hidden flex-1 overflow-y-auto px-4 pt-2 pb-32 relative">
        {/* Pinned Sticky Control Header directly under main app header */}
        <div className="sticky top-0 z-40 bg-stone-50/95 dark:bg-black/95 backdrop-blur-md pb-3 pt-1 -mx-4 px-4 border-b border-stone-200/80 dark:border-zinc-800/80 space-y-2.5">
          {/* Sticky Search Bar */}
          <div className="relative w-full">
            <Search className="w-4 h-4 text-stone-400 dark:text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                activeSubTab === 'participants'
                  ? `Search by name, school, or ${categoryLabel.toLowerCase()}...`
                  : 'Search judges by name, PIN, or ID...'
              }
              className="w-full min-h-[44px] pl-10 pr-10 rounded-xl bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-sm font-medium text-stone-900 dark:text-white placeholder:text-stone-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 transition-all shadow-xs"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-stone-400 hover:text-stone-600 dark:hover:text-zinc-200 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Segmented Control with Baked-in Counts */}
          <div className="flex w-full p-0.5 bg-stone-200/70 dark:bg-zinc-900 rounded-xl border border-stone-200/60 dark:border-zinc-800 shadow-inner">
            <button
              type="button"
              onClick={() => {
                setActiveSubTab('participants');
                setSearchQuery('');
              }}
              className={`flex-1 min-h-[38px] px-3 rounded-lg text-xs font-bold transition-all flex items-center justify-center space-x-1.5 cursor-pointer ${
                activeSubTab === 'participants'
                  ? 'bg-white dark:bg-zinc-950 text-stone-900 dark:text-white shadow-sm border border-stone-200/60 dark:border-zinc-800'
                  : 'text-stone-500 dark:text-zinc-400 hover:text-stone-900 dark:hover:text-white'
              }`}
            >
              <Users className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              <span>Participants ({participants.length})</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveSubTab('judges');
                setSearchQuery('');
              }}
              className={`flex-1 min-h-[38px] px-3 rounded-lg text-xs font-bold transition-all flex items-center justify-center space-x-1.5 cursor-pointer ${
                activeSubTab === 'judges'
                  ? 'bg-white dark:bg-zinc-950 text-stone-900 dark:text-white shadow-sm border border-stone-200/60 dark:border-zinc-800'
                  : 'text-stone-500 dark:text-zinc-400 hover:text-stone-900 dark:hover:text-white'
              }`}
            >
              <Gavel className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              <span>Judges Jury ({judges.length})</span>
            </button>
          </div>
        </div>

        {/* Compact Action Cards (Zero-Bloat) */}
        {activeSubTab === 'participants' ? (
          <div className="mt-3.5 bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl p-3 shadow-sm space-y-3">
            {/* Top Row (Centered): Sleek thin pill button */}
            <div className="flex justify-center">
              <button
                type="button"
                onClick={handleDownloadTemplate}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold text-stone-600 dark:text-zinc-400 bg-stone-100 hover:bg-stone-200 dark:bg-zinc-900 dark:hover:bg-zinc-800 border border-stone-200 dark:border-zinc-800 transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-emerald-500" />
                <span>Download Template</span>
              </button>
            </div>

            {/* Bottom Row (Split 50/50): [Export Excel] | [Import Excel] */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleExportParticipantsExcel}
                className="min-h-[42px] px-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl shadow-sm shadow-emerald-600/20 active:scale-95 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <FileSpreadsheet className="w-4 h-4 stroke-[2.2]" />
                <span>Export Excel</span>
              </button>

              <label className="min-h-[42px] px-3 bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs rounded-xl shadow-sm shadow-blue-600/20 active:scale-95 transition-all flex items-center justify-center gap-1.5 cursor-pointer">
                <Upload className="w-4 h-4 stroke-[2.2]" />
                <span>Import Excel</span>
                <input
                  type="file"
                  accept=".xlsx"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </label>
            </div>
          </div>
        ) : (
          <div className="mt-3.5 bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl p-3 shadow-sm">
            <button
              type="button"
              onClick={handleTriggerPrint}
              className="w-full min-h-[42px] px-4 bg-orange-500 hover:bg-orange-600 text-white font-bold text-xs rounded-xl shadow-sm shadow-orange-500/25 active:scale-95 transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              <Printer className="w-4 h-4 stroke-[2.2]" />
              <span>Export Judge Badges (PDF)</span>
            </button>
          </div>
        )}

        <div className="mt-3.5 space-y-3.5">
          {/* First-Time Setup Prompt: Categorization Preference */}
          {activeSubTab === 'participants' && showCategoryPrompt && (
            <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-in fade-in">
              <div className="flex items-center space-x-3">
                <Sparkles className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <div>
                  <h4 className="text-xs font-bold text-zinc-900 dark:text-white">
                    Setup Participant Categorization
                  </h4>
                  <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
                    How are competitors grouped for your events?
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleSelectCategoryPreference('Class/Grade')}
                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold active:scale-95 transition-all cursor-pointer"
                >
                  By Class / Grade
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectCategoryPreference('Age Group')}
                  className="px-3 py-1.5 bg-stone-200 dark:bg-zinc-800 hover:bg-stone-300 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 rounded-xl text-xs font-bold active:scale-95 transition-all cursor-pointer"
                >
                  By Age Group
                </button>
              </div>
            </div>
          )}

          {/* Upload notice message */}
          {uploadNotice && (
            <div
              className={`p-3.5 rounded-2xl flex items-center space-x-2.5 text-xs font-semibold ${
                uploadNotice.type === 'success'
                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20'
                  : 'bg-red-500/10 text-red-700 dark:text-red-400 border border-red-500/20'
              }`}
            >
              {uploadNotice.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0" />
              )}
              <span>{uploadNotice.msg}</span>
            </div>
          )}

          {/* ======================================================== */}
          {/* 1. PARTICIPANTS SUB-TAB CONTENT                          */}
          {/* ======================================================== */}
          {activeSubTab === 'participants' && (
            <div className="space-y-4">
              {/* Active columns: Tap-to-Reveal Accordion */}
              <div className="rounded-xl border border-stone-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden shadow-xs">
                <button
                  type="button"
                  onClick={() => setShowColumnsConfig(!showColumnsConfig)}
                  className="w-full min-h-[42px] px-3.5 py-2 flex items-center justify-between text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-stone-50 dark:hover:bg-zinc-900/50 transition-all cursor-pointer"
                >
                  <div className="flex items-center space-x-2">
                    <Sliders className="w-3.5 h-3.5 text-emerald-500" />
                    <span>Columns & Categorization</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-stone-100 dark:bg-zinc-800 text-zinc-500 font-semibold">
                      {3 + customFields.length} Active
                    </span>
                  </div>
                  {showColumnsConfig ? (
                    <ChevronUp className="w-4 h-4 text-zinc-400" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-zinc-400" />
                  )}
                </button>

                {showColumnsConfig && (
                  <div className="p-3.5 border-t border-stone-200 dark:border-zinc-800 bg-stone-50/50 dark:bg-zinc-900/30 space-y-3 animate-in fade-in">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="px-2.5 py-1 rounded-lg bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 font-semibold text-zinc-700 dark:text-zinc-300">
                        Full Name
                      </span>
                      <span className="px-2.5 py-1 rounded-lg bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 font-semibold text-zinc-700 dark:text-zinc-300">
                        School / Institution
                      </span>
                      
                      {/* Dynamic Category Pill */}
                      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 font-bold text-emerald-700 dark:text-emerald-400">
                        <span>{categoryLabel}</span>
                        <button
                          type="button"
                          onClick={() => setIsEditingCategoryLabel(!isEditingCategoryLabel)}
                          className="p-0.5 hover:text-emerald-900 dark:hover:text-white cursor-pointer"
                          title="Change category format"
                        >
                          <Settings className="w-3 h-3" />
                        </button>
                      </div>

                      <span className="px-2.5 py-1 rounded-lg bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-zinc-500">
                        Mobile (Opt)
                      </span>

                      {/* Additional Custom Fields Chips with Delete Action */}
                      {customFields.map((cf) => (
                        <span
                          key={cf.id}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-700 dark:text-blue-400 font-semibold"
                        >
                          <span>{cf.name}</span>
                          <button
                            type="button"
                            onClick={() => handleDeleteCustomField(cf.id, cf.name)}
                            className="p-0.5 hover:text-red-500 cursor-pointer"
                            title="Delete custom header"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                    </div>

                    {/* Categorization Format Switcher Popover */}
                    {isEditingCategoryLabel && (
                      <div className="p-3 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl space-y-2">
                        <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300 block">
                          Choose Categorization Format:
                        </span>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => handleSelectCategoryPreference('Class/Grade')}
                            className={`px-3 py-1 rounded-lg text-xs font-bold cursor-pointer transition-all ${
                              categoryLabel === 'Class/Grade'
                                ? 'bg-emerald-600 text-white'
                                : 'bg-stone-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
                            }`}
                          >
                            Class/Grade
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSelectCategoryPreference('Age Group')}
                            className={`px-3 py-1 rounded-lg text-xs font-bold cursor-pointer transition-all ${
                              categoryLabel === 'Age Group'
                                ? 'bg-emerald-600 text-white'
                                : 'bg-stone-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
                            }`}
                          >
                            Age Group
                          </button>
                          <div className="flex items-center gap-1">
                            <input
                              type="text"
                              placeholder="Custom label..."
                              value={customCategoryInput}
                              onChange={(e) => setCustomCategoryInput(e.target.value)}
                              className="px-2 py-1 text-xs rounded-lg bg-stone-50 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 text-zinc-900 dark:text-white"
                            />
                            {customCategoryInput && (
                              <button
                                type="button"
                                onClick={() => {
                                  handleSelectCategoryPreference(customCategoryInput.trim());
                                  setCustomCategoryInput('');
                                }}
                                className="px-2 py-1 bg-emerald-600 text-white rounded-lg text-xs font-bold cursor-pointer"
                              >
                                Apply
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Participants List */}
              {filteredParticipants.length === 0 ? (
                <div className="p-8 text-center bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 text-zinc-500 text-xs">
                  {searchQuery
                    ? 'No participants match your search.'
                    : 'No participants found. Add manually or import via Excel above.'}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {filteredParticipants.map((p) => (
                    <div
                      key={p.id}
                      className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 shadow-sm flex items-start justify-between space-x-3 transition-all hover:border-stone-300 dark:hover:border-zinc-700"
                    >
                      <div className="flex items-start space-x-3 min-w-0 flex-1">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm font-bold text-zinc-900 dark:text-white truncate">
                              {p.name}
                            </h4>
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-stone-100 dark:bg-zinc-800 text-stone-600 dark:text-zinc-300 border border-stone-200 dark:border-zinc-700/60 shrink-0">
                              {p.identity_id || `P-${p.sl_no || '0000'}`}
                            </span>
                          </div>
                          <div className="flex items-center space-x-1.5 text-xs text-zinc-500 truncate mt-0.5">
                            <Building className="w-3 h-3 text-zinc-400 shrink-0" />
                            <span className="truncate">{p.school}</span>
                          </div>
                          {p.class_or_age && (
                            <div className="flex items-center space-x-1.5 text-[11px] text-zinc-400 truncate mt-0.5 font-mono">
                              <GraduationCap className="w-3 h-3 text-zinc-400 shrink-0" />
                              <span>{categoryLabel}: {p.class_or_age}</span>
                            </div>
                          )}
                          {p.mobile_number && (
                            <div className="flex items-center space-x-1.5 text-[11px] text-zinc-400 truncate mt-0.5 font-mono">
                              <Phone className="w-3 h-3 text-zinc-400 shrink-0" />
                              <span>{p.mobile_number}</span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center space-x-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleOpenEditParticipant(p)}
                          className="p-2 rounded-xl text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-stone-100 dark:hover:bg-zinc-900 cursor-pointer"
                          title="Edit"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => promptDeleteParticipant(p.id, p.name)}
                          className="p-2 rounded-xl text-zinc-400 hover:text-red-600 hover:bg-red-500/10 cursor-pointer"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ======================================================== */}
          {/* 2. JUDGES SUB-TAB CONTENT                                */}
          {/* ======================================================== */}
          {activeSubTab === 'judges' && (
            <div className="space-y-4">
              {filteredJudges.length === 0 ? (
                <div className="p-8 text-center bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 text-zinc-500 text-xs">
                  {searchQuery
                    ? 'No judges match your search.'
                    : 'No judges found. Click "Add Judge" to create judge profiles.'}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {filteredJudges.map((j) => {
                    const qrPayload = getJudgeQrPayload(j);
                    return (
                      <div
                        key={j.id}
                        className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800/80 rounded-2xl p-4 shadow-sm flex flex-col justify-between space-y-3"
                      >
                        <div className="flex items-start justify-between">
                          <div>
                            <h4 className="text-sm font-bold text-zinc-900 dark:text-white">
                              {j.name}
                            </h4>
                            <div className="flex items-center space-x-2 mt-1">
                              <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 font-bold">
                                ID: {j.judge_id || j.id.slice(0, 6)}
                              </span>
                              <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                                PIN: {j.pin}
                              </span>
                            </div>
                          </div>

                          {/* Clickable Large QR Thumbnail Button */}
                          <button
                            type="button"
                            onClick={() => handleOpenQrModal(j)}
                            title="Click to view large QR Code"
                            className="p-1.5 rounded-xl bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 hover:border-emerald-500 transition-all cursor-pointer group"
                          >
                            <QRCodeSVG
                              value={qrPayload}
                              size={44}
                              level="M"
                            />
                          </button>
                        </div>

                        <div className="flex items-center justify-between pt-2 border-t border-stone-100 dark:border-zinc-900">
                          {/* Copy Credentials Button */}
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(
                                `Fair Judge Credentials\nOrg ID: ${organization.org_id}\nJudge ID: ${j.judge_id || j.id.slice(0, 6)}\nPIN: ${j.pin}\n\nScan QR or sign in with PIN.`
                              );
                              setCopiedJudgePin(j.id);
                              setTimeout(() => setCopiedJudgePin(null), 2000);
                            }}
                            className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 flex items-center space-x-1 cursor-pointer"
                          >
                            {copiedJudgePin === j.id ? (
                              <>
                                <Check className="w-3.5 h-3.5" />
                                <span>Copied</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                <span>Copy Credentials</span>
                              </>
                            )}
                          </button>

                          <div className="flex items-center space-x-1">
                            {/* View Judge Details (Eye Icon) */}
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedJudgeForDetails(j);
                                setShowJudgeDetailsModal(true);
                              }}
                              className="p-1.5 text-zinc-400 hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer rounded-lg hover:bg-stone-100 dark:hover:bg-zinc-900 transition-colors"
                              title="View Judge Details"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleOpenEditJudge(j)}
                              className="p-1.5 text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 cursor-pointer rounded-lg hover:bg-stone-100 dark:hover:bg-zinc-900 transition-colors"
                              title="Edit"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => promptDeleteJudge(j.id, j.name)}
                              className="p-1.5 text-zinc-400 hover:text-red-600 cursor-pointer rounded-lg hover:bg-red-500/10 transition-colors"
                              title="Delete"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Floating Action Button (FAB) */}
        <button
          type="button"
          onClick={() => {
            if (activeSubTab === 'participants') {
              handleOpenAddParticipant();
            } else {
              handleOpenAddJudge();
            }
          }}
          className={`fixed bottom-24 right-6 z-50 w-14 h-14 text-white rounded-2xl shadow-xl flex items-center justify-center active:scale-95 transition-all cursor-pointer ${
            activeSubTab === 'participants'
              ? 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/30'
              : 'bg-orange-500 hover:bg-orange-600 shadow-orange-500/30'
          }`}
          title={activeSubTab === 'participants' ? 'Add Competitor' : 'Add Judge'}
          aria-label={activeSubTab === 'participants' ? 'Add Competitor' : 'Add Judge'}
        >
          <Plus className="w-6 h-6 stroke-[2.5]" />
        </button>
      </div>

      {/* ======================================================== */}
      {/* EXCEL STAGING PREVIEW MODAL (Absolute Z-Index [200])     */}
      {/* ======================================================== */}
      {showStagingModal && (
        <div className="fixed inset-0 z-[200] bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 pointer-events-auto animate-in fade-in">
          <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl max-w-2xl w-full max-h-[85dvh] flex flex-col shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="p-4 border-b border-stone-200 dark:border-zinc-800 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-zinc-900 dark:text-white flex items-center gap-2">
                  <FileSpreadsheet className="w-4 h-4 text-emerald-500" />
                  <span>Review Excel Import</span>
                </h3>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {stagedRows.filter((r) => r.isValid).length} valid rows ·{' '}
                  {stagedRows.filter((r) => !r.isValid).length} rows with issues
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowStagingModal(false);
                  setStagedRows([]);
                }}
                className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Staging Body Table */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2 pb-12">
              <div className="text-xs text-zinc-500 mb-2">
                Rows highlighted in red have missing mandatory fields (Full Name or School). You can remove them or fix your Excel file.
              </div>

              <div className="border border-stone-200 dark:border-zinc-800 rounded-xl overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-stone-100 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 font-bold border-b border-stone-200 dark:border-zinc-800">
                    <tr>
                      <th className="p-2.5">Status</th>
                      <th className="p-2.5">Full Name</th>
                      <th className="p-2.5">School / Team</th>
                      <th className="p-2.5">{categoryLabel}</th>
                      <th className="p-2.5">Mobile</th>
                      <th className="p-2.5 text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-200 dark:divide-zinc-800">
                    {stagedRows.map((row) => (
                      <tr
                        key={row.id}
                        className={
                          !row.isValid
                            ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                            : 'hover:bg-stone-50 dark:hover:bg-zinc-900/50'
                        }
                      >
                        <td className="p-2.5">
                          {row.isValid ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                              <Check className="w-3.5 h-3.5" />
                              <span>Valid</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-red-600 dark:text-red-400">
                              <AlertCircle className="w-3.5 h-3.5" />
                              <span>{row.validationError}</span>
                            </span>
                          )}
                        </td>
                        <td className="p-2.5 font-semibold text-zinc-900 dark:text-white">
                          {row.name || <span className="italic text-red-500">Missing</span>}
                        </td>
                        <td className="p-2.5 text-zinc-600 dark:text-zinc-400">
                          {row.school || <span className="italic text-red-500">Missing</span>}
                        </td>
                        <td className="p-2.5 text-zinc-600 dark:text-zinc-400">
                          {row.class_or_age || '—'}
                        </td>
                        <td className="p-2.5 text-zinc-600 dark:text-zinc-400 font-mono">
                          {row.mobile_number || '—'}
                        </td>
                        <td className="p-2.5 text-center">
                          <button
                            type="button"
                            onClick={() => handleRemoveStagedRow(row.id)}
                            className="p-1 text-zinc-400 hover:text-red-500 cursor-pointer"
                            title="Discard this row"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-stone-200 dark:border-zinc-800 flex items-center justify-between gap-3 bg-stone-50/50 dark:bg-zinc-950 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setShowStagingModal(false);
                  setStagedRows([]);
                }}
                className="min-h-[44px] px-4 rounded-xl border border-stone-200 dark:border-zinc-800 text-xs font-bold text-zinc-600 dark:text-zinc-400 hover:bg-stone-100 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isImporting || stagedRows.filter((r) => r.isValid).length === 0}
                onClick={handleConfirmImport}
                className="min-h-[44px] px-5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-md shadow-emerald-600/20 active:scale-95 transition-all disabled:opacity-50 cursor-pointer flex items-center gap-2"
              >
                {isImporting ? (
                  <span>Importing...</span>
                ) : (
                  <>
                    <Check className="w-4 h-4 stroke-[2.5]" />
                    <span>
                      Confirm & Import {stagedRows.filter((r) => r.isValid).length} Participants
                    </span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* FULL-SCREEN PARTICIPANT CREATION WIZARD                  */}
      {/* ======================================================== */}
      {showParticipantModal && (
        <div className="fixed inset-0 z-[120] bg-stone-50 dark:bg-black overflow-y-auto flex flex-col pointer-events-auto animate-in fade-in duration-150">
          {/* Sticky Top Header */}
          <div className="sticky top-0 z-10 bg-stone-50/95 dark:bg-black/95 backdrop-blur-md px-4 py-3.5 flex justify-between items-center border-b border-stone-200 dark:border-zinc-800">
            <button
              type="button"
              onClick={() => setShowParticipantModal(false)}
              className="text-xs font-bold text-stone-600 dark:text-zinc-400 hover:text-stone-900 dark:hover:text-white px-3 py-1.5 rounded-lg hover:bg-stone-200/50 dark:hover:bg-zinc-900 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <span className="text-[11px] font-mono font-black uppercase tracking-wider text-stone-400 dark:text-zinc-500">
              {editingParticipant ? 'EDIT COMPETITOR' : 'NEW COMPETITOR'}
            </span>
            <button
              type="button"
              onClick={handleSaveParticipant}
              className="min-h-[36px] px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-md shadow-emerald-600/20 active:scale-95 transition-all cursor-pointer flex items-center gap-1.5"
            >
              <Check className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>Save</span>
            </button>
          </div>

          {/* Form Body */}
          <div className="flex-1 max-w-2xl w-full mx-auto px-4 py-6 space-y-6">
            {/* Massive Borderless Name Input */}
            <div className="space-y-1">
              <label className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 tracking-wider uppercase block">
                Full Name <span className="text-emerald-500">*</span>
              </label>
              <input
                type="text"
                value={participantForm.name}
                onChange={(e) => setParticipantForm({ ...participantForm, name: e.target.value })}
                placeholder="Participant Name..."
                className="text-3xl sm:text-4xl font-black bg-transparent border-none text-stone-900 dark:text-white focus:outline-none placeholder:text-stone-300 dark:placeholder:text-zinc-700 w-full"
                autoFocus
              />
            </div>

            {/* Grouped Card for remaining fields */}
            <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 sm:p-5 space-y-4 shadow-sm">
              {/* Field: School / Institution (Mandatory) */}
              <div>
                <label className="text-[11px] font-bold text-stone-500 dark:text-zinc-400 tracking-wider mb-1 uppercase block">
                  School / Institution <span className="text-emerald-500">*</span>
                </label>
                <input
                  type="text"
                  value={participantForm.school}
                  onChange={(e) => setParticipantForm({ ...participantForm, school: e.target.value })}
                  placeholder="e.g. Modern High School, DPS, Team Alpha"
                  className="w-full min-h-[46px] px-3.5 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-sm font-semibold text-stone-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />
              </div>

              {/* Dynamic Categorization & Mobile */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-bold text-stone-500 dark:text-zinc-400 tracking-wider mb-1 uppercase block">
                    {categoryLabel}
                  </label>
                  <input
                    type="text"
                    value={participantForm.class_or_age}
                    onChange={(e) => setParticipantForm({ ...participantForm, class_or_age: e.target.value })}
                    placeholder={categoryLabel.toLowerCase().includes('age') ? '14-16 Yrs' : 'Grade 10'}
                    className="w-full min-h-[46px] px-3.5 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-sm font-medium text-stone-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-bold text-stone-500 dark:text-zinc-400 tracking-wider mb-1 uppercase block">
                    Mobile Number (Optional)
                  </label>
                  <input
                    type="tel"
                    value={participantForm.mobile_number}
                    onChange={(e) => setParticipantForm({ ...participantForm, mobile_number: e.target.value })}
                    placeholder="9876543210"
                    className="w-full min-h-[46px] px-3.5 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-sm font-mono text-stone-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                  />
                </div>
              </div>

              {/* Dynamic custom fields configured in organization */}
              {customFields.map((cf) => (
                <div key={cf.id}>
                  <label className="text-[11px] font-bold text-stone-500 dark:text-zinc-400 tracking-wider mb-1 uppercase block">
                    {cf.name} {cf.required && <span className="text-emerald-500">*</span>}
                  </label>
                  <input
                    type={cf.type || 'text'}
                    value={participantForm.custom_values[cf.id] || ''}
                    onChange={(e) =>
                      setParticipantForm({
                        ...participantForm,
                        custom_values: {
                          ...participantForm.custom_values,
                          [cf.id]: e.target.value,
                        },
                      })
                    }
                    className="w-full min-h-[46px] px-3.5 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-sm font-medium text-stone-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* FULL-SCREEN JUDGE CREATION WIZARD                        */}
      {/* ======================================================== */}
      {showJudgeModal && (
        <div className="fixed inset-0 z-[120] bg-stone-50 dark:bg-black overflow-y-auto flex flex-col pointer-events-auto animate-in fade-in duration-150">
          {/* Sticky Top Header */}
          <div className="sticky top-0 z-10 bg-stone-50/95 dark:bg-black/95 backdrop-blur-md px-4 py-3.5 flex justify-between items-center border-b border-stone-200 dark:border-zinc-800">
            <button
              type="button"
              onClick={() => setShowJudgeModal(false)}
              className="text-xs font-bold text-stone-600 dark:text-zinc-400 hover:text-stone-900 dark:hover:text-white px-3 py-1.5 rounded-lg hover:bg-stone-200/50 dark:hover:bg-zinc-900 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <span className="text-[11px] font-mono font-black uppercase tracking-wider text-stone-400 dark:text-zinc-500">
              {editingJudge ? 'EDIT JUDGE PROFILE' : 'NEW JUDGE PROFILE'}
            </span>
            <button
              type="button"
              onClick={handleSaveJudge}
              className="min-h-[36px] px-4 rounded-xl bg-orange-500 hover:bg-orange-600 text-white text-xs font-bold shadow-md shadow-orange-500/20 active:scale-95 transition-all cursor-pointer flex items-center gap-1.5"
            >
              <Check className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>Save</span>
            </button>
          </div>

          {/* Form Body */}
          <div className="flex-1 max-w-2xl w-full mx-auto px-4 py-6 space-y-6">
            {/* Massive Borderless Name Input */}
            <div className="space-y-1">
              <label className="text-[11px] font-bold text-orange-600 dark:text-orange-400 tracking-wider uppercase block">
                Judge Full Name <span className="text-orange-500">*</span>
              </label>
              <input
                type="text"
                value={judgeForm.name}
                onChange={(e) => setJudgeForm({ ...judgeForm, name: e.target.value })}
                placeholder="Judge Full Name..."
                className="text-3xl sm:text-4xl font-black bg-transparent border-none text-stone-900 dark:text-white focus:outline-none placeholder:text-stone-300 dark:placeholder:text-zinc-700 w-full"
                autoFocus
              />
            </div>

            {/* Grouped Card */}
            <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 sm:p-5 space-y-4 shadow-sm">
              {/* Field 1: Organisation ID (READ-ONLY) */}
              <div>
                <label className="text-[11px] font-bold text-stone-500 dark:text-zinc-400 tracking-wider mb-1 uppercase block">
                  Organisation ID (Read-Only)
                </label>
                <input
                  type="text"
                  readOnly
                  value={organization.org_id}
                  className="w-full min-h-[46px] px-3.5 rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-sm font-mono font-bold text-stone-500 dark:text-zinc-400 select-all cursor-default"
                />
              </div>

              {/* Field 2 & 3: Auto-Generated Judge ID & 4-Digit PIN */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-bold text-stone-500 dark:text-zinc-400 tracking-wider mb-1 uppercase block">
                    Judge ID Code
                  </label>
                  <input
                    type="text"
                    value={judgeForm.judge_id}
                    onChange={(e) => setJudgeForm({ ...judgeForm, judge_id: e.target.value })}
                    className="w-full min-h-[46px] px-3.5 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-sm font-mono font-bold text-stone-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-bold text-stone-500 dark:text-zinc-400 tracking-wider mb-1 uppercase block">
                    4-Digit PIN
                  </label>
                  <input
                    type="text"
                    maxLength={6}
                    value={judgeForm.pin}
                    onChange={(e) => setJudgeForm({ ...judgeForm, pin: e.target.value })}
                    className="w-full min-h-[46px] px-3.5 text-center rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-sm font-mono font-black text-emerald-600 dark:text-emerald-400"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* 1. CLEAN SHOW QR MODAL (Only Judge Name, QR, Branding)   */}
      {/* ======================================================== */}
      {showQrModal && selectedJudgeForQr && (
        <div className="fixed inset-0 z-[120] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-3xl max-w-xs w-full p-6 text-center shadow-2xl space-y-4 animate-in zoom-in-95">
            {/* Top: Judge's Name (Bold, Top) with Close X */}
            <div className="flex items-center justify-between pb-2 border-b border-stone-100 dark:border-zinc-800/80">
              <h3 className="text-base font-extrabold text-zinc-900 dark:text-white truncate">
                {selectedJudgeForQr.name}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setShowQrModal(false);
                  setSelectedJudgeForQr(null);
                }}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Centered Large Scannable QR Code */}
            <div className="flex justify-center p-3 bg-white rounded-2xl border border-stone-200 dark:border-zinc-800 shadow-xs">
              <QRCodeSVG
                value={getJudgeQrPayload(selectedJudgeForQr)}
                size={210}
                level="H"
                includeMargin
              />
            </div>

            {/* Bottom: App Logo / Name / Developer Branding (Small Font Size, Below QR) */}
            <div className="pt-3 border-t border-stone-100 dark:border-zinc-800/80 space-y-1">
              <div className="flex items-center justify-center space-x-1.5">
                <div className="w-4 h-4 rounded bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-500">
                  <Scale className="w-2.5 h-2.5" />
                </div>
                <span className="font-extrabold text-xs text-zinc-900 dark:text-white tracking-tight">
                  Fair Judge
                </span>
              </div>
              <p className="text-[10px] text-zinc-400 dark:text-zinc-500 font-mono">
                Engineered by Sahil Kumar Rout
              </p>
            </div>

            {/* Done Action Button */}
            <button
              type="button"
              onClick={() => {
                setShowQrModal(false);
                setSelectedJudgeForQr(null);
              }}
              className="w-full min-h-[40px] px-3 rounded-xl bg-zinc-900 hover:bg-zinc-800 dark:bg-white dark:hover:bg-zinc-100 text-white dark:text-black text-xs font-bold transition-all active:scale-95 cursor-pointer shadow-sm"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* 2. JUDGE DOSSIER & DETAILS MODAL (Eye Icon Triggered)    */}
      {/* ======================================================== */}
      {showJudgeDetailsModal && selectedJudgeForDetails && (
        <div className="fixed inset-0 z-[120] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-3xl max-w-sm w-full p-6 text-left shadow-2xl space-y-4 animate-in zoom-in-95">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-stone-100 dark:border-zinc-800">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 flex items-center justify-center">
                  <Gavel className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-zinc-900 dark:text-white leading-tight">
                    Judge Dossier
                  </h3>
                  <p className="text-xs text-zinc-500 font-mono">
                    Evaluator Profile &amp; Access
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowJudgeDetailsModal(false);
                  setSelectedJudgeForDetails(null);
                }}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Details List */}
            <div className="space-y-3">
              {/* Name */}
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block">
                  Judge Name
                </span>
                <p className="text-sm font-bold text-zinc-900 dark:text-white mt-0.5">
                  {selectedJudgeForDetails.name}
                </p>
              </div>

              {/* Credentials Grid */}
              <div className="grid grid-cols-2 gap-2 text-xs font-mono bg-stone-100 dark:bg-zinc-900 p-3 rounded-2xl border border-stone-200 dark:border-zinc-800">
                <div>
                  <span className="text-[10px] text-zinc-400 block uppercase font-bold">Judge ID</span>
                  <span className="font-bold text-zinc-900 dark:text-white text-sm">
                    {selectedJudgeForDetails.judge_id || selectedJudgeForDetails.id.slice(0, 6)}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-zinc-400 block uppercase font-bold">4-Digit PIN</span>
                  <span className="font-bold text-emerald-600 dark:text-emerald-400 text-sm">
                    {selectedJudgeForDetails.pin}
                  </span>
                </div>
              </div>

              {/* Organization */}
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block">
                  Host Organization
                </span>
                <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 mt-0.5">
                  {organization.name} <span className="font-mono text-zinc-400">({organization.org_id})</span>
                </p>
              </div>

              {/* Assigned Events */}
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block mb-1">
                  Assigned Stages &amp; Events
                </span>
                {(() => {
                  const judgeEvents = events.filter((e) =>
                    (e.assigned_judges || []).includes(selectedJudgeForDetails.id) ||
                    (selectedJudgeForDetails.assigned_events || []).includes(e.id)
                  );
                  if (judgeEvents.length === 0) {
                    return (
                      <p className="text-xs text-zinc-400 italic">No specific events assigned yet.</p>
                    );
                  }
                  return (
                    <div className="space-y-1.5 max-h-36 overflow-y-auto">
                      {judgeEvents.map((ev) => (
                        <div
                          key={ev.id}
                          className="p-2 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200/60 dark:border-zinc-800 text-xs flex items-center justify-between"
                        >
                          <span className="font-semibold text-zinc-800 dark:text-zinc-200 truncate">
                            {ev.name}
                          </span>
                          <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded font-bold bg-stone-200/60 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                            {ev.status || 'draft'}
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="pt-2 flex items-center space-x-2">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(
                    `Fair Judge Credentials\nOrg ID: ${organization.org_id}\nJudge ID: ${selectedJudgeForDetails.judge_id || selectedJudgeForDetails.id.slice(0, 6)}\nPIN: ${selectedJudgeForDetails.pin}\n\nScan QR or sign in with PIN.`
                  );
                  setCopiedJudgePin(selectedJudgeForDetails.id);
                  setTimeout(() => setCopiedJudgePin(null), 2000);
                }}
                className="flex-1 min-h-[42px] px-3 rounded-xl bg-stone-100 hover:bg-stone-200 dark:bg-zinc-900 dark:hover:bg-zinc-800 text-stone-700 dark:text-zinc-200 text-xs font-bold flex items-center justify-center space-x-1.5 transition-all cursor-pointer"
              >
                {copiedJudgePin === selectedJudgeForDetails.id ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-500" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy Credentials</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowJudgeDetailsModal(false);
                  setSelectedJudgeForDetails(null);
                }}
                className="min-h-[42px] px-4 rounded-xl bg-zinc-900 hover:bg-zinc-800 dark:bg-white dark:hover:bg-zinc-100 text-white dark:text-black text-xs font-bold transition-all cursor-pointer shadow-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* 3. STANDARDIZED DELETION CONFIRMATION MODAL               */}
      {/* ======================================================== */}
      {deleteModalState && deleteModalState.isOpen && (
        <div className="fixed inset-0 z-[120] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95">
            <div className="flex items-center space-x-3 text-red-600 dark:text-red-400">
              <div className="w-10 h-10 rounded-2xl bg-red-500/15 flex items-center justify-center">
                <Trash2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-zinc-900 dark:text-white leading-tight">
                  {deleteModalState.type === 'participant' ? 'Remove Participant?' : 'Remove Judge?'}
                </h3>
                <p className="text-xs text-red-600 dark:text-red-400 font-mono">
                  Permanent removal
                </p>
              </div>
            </div>

            <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
              Permanently remove <strong className="text-zinc-900 dark:text-white">{deleteModalState.name}</strong> from the official competition roster? This action cannot be undone.
            </p>

            <div className="grid grid-cols-2 gap-3 pt-1">
              <button
                type="button"
                onClick={() => setDeleteModalState(null)}
                className="min-h-[42px] bg-stone-100 hover:bg-stone-200 dark:bg-zinc-900 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs font-bold rounded-xl active:scale-95 transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                className="min-h-[42px] bg-red-600 hover:bg-red-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-red-600/25 active:scale-95 transition-all cursor-pointer flex items-center justify-center space-x-1.5"
              >
                <Trash2 className="w-4 h-4" />
                <span>{deleteModalState.type === 'participant' ? 'Remove Participant' : 'Remove Judge'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
