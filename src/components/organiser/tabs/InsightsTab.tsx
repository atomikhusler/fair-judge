import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import { 
  Trophy, 
  FileSpreadsheet, 
  Printer, 
  Search, 
  Clock, 
  ChevronDown, 
  ChevronUp, 
  Check, 
  Gavel, 
  Scale, 
  X,
  AlertTriangle,
  Users,
  TrendingUp,
  TrendingDown,
  ShieldCheck,
  ShieldAlert,
  UserX,
  Sliders,
  Sparkles,
  Award
} from 'lucide-react';
import { 
  Organization, 
  SupabaseEvent, 
  SupabaseJudge, 
  SupabaseParticipant, 
  SupabaseScore 
} from '../../../lib/supabaseTypes';
import { dbService, subscribeToDatabase } from '../../../lib/supabase';
import { eventBus } from '../../../lib/eventBus';

interface InsightsTabProps {
  organization: Organization;
}

type InsightsPillar = 'results' | 'stats' | 'analytics' | 'logs';

interface ParticipantStanding {
  participant: SupabaseParticipant;
  ballotCount: number;
  rawTotal: number;
  averageScore: number;
  rank: number;
  isTied: boolean;
}

export function InsightsTab({ organization }: InsightsTabProps) {
  // --- STATE (Optimistically seeded from local cache to prevent flashing) ---
  const [activePillar, setActivePillar] = useState<InsightsPillar>('results');
  const [events, setEvents] = useState<SupabaseEvent[]>(() =>
    dbService.getCachedEvents(organization.org_id)
  );
  const [judges, setJudges] = useState<SupabaseJudge[]>(() =>
    dbService.getCachedJudges(organization.org_id)
  );
  const [participants, setParticipants] = useState<SupabaseParticipant[]>(() =>
    dbService.getCachedParticipants(organization.org_id)
  );
  const [allScores, setAllScores] = useState<SupabaseScore[]>(() =>
    dbService.getCachedScores()
  );
  // Accordion state for Stats section
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});

  // Filter states for Logs section
  const [selectedEventFilter, setSelectedEventFilter] = useState<string>('all');
  const [selectedJudgeFilter, setSelectedJudgeFilter] = useState<string>('all');
  const [searchAudit, setSearchAudit] = useState<string>('');
  const [isEventDropdownOpen, setIsEventDropdownOpen] = useState(false);
  const [isJudgeDropdownOpen, setIsJudgeDropdownOpen] = useState(false);

  // Pure Event-Driven Architecture: Subscribe to eventBus cache updates with zero-flash hydration
  useEffect(() => {
    const unsubBus = eventBus.on('cache_updated', (payload) => {
      const table = payload?.table;
      if (!table || table === 'events' || table === 'all') {
        setEvents(dbService.getCachedEvents(organization.org_id));
      }
      if (!table || table === 'judges' || table === 'all') {
        setJudges(dbService.getCachedJudges(organization.org_id));
      }
      if (!table || table === 'participants' || table === 'all') {
        setParticipants(dbService.getCachedParticipants(organization.org_id));
      }
      if (!table || table === 'scores' || table === 'all') {
        setAllScores(dbService.getCachedScores());
      }
    });

    // Quiet SWR background verification (checks 5-minute TTL without blocking or showing loaders)
    dbService.getEvents(organization.org_id);
    dbService.getJudges(organization.org_id);
    dbService.getParticipants(organization.org_id);
    dbService.getAllScores();

    return () => unsubBus();
  }, [organization.org_id]);

  // --- LOOKUP MAPS ---
  const eventMap = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const judgeMap = useMemo(() => new Map(judges.map((j) => [j.id, j])), [judges]);
  const participantMap = useMemo(() => new Map(participants.map((p) => [p.id, p])), [participants]);

  // --- DERIVED EVENT STANDINGS WITH EQUAL TIE-BREAKER LOGIC ---
  const eventStandings = useMemo(() => {
    return events.map((ev) => {
      const evScores = allScores.filter((s) => s.event_id === ev.id);
      const byParticipant = new Map<string, SupabaseScore[]>();

      evScores.forEach((s) => {
        const list = byParticipant.get(s.participant_id) || [];
        list.push(s);
        byParticipant.set(s.participant_id, list);
      });

      // Step 1: calculate raw totals and averages
      const unranked: Array<Omit<ParticipantStanding, 'rank' | 'isTied'>> = Array.from(byParticipant.entries())
        .map(([pId, scores]) => {
          const p = participantMap.get(pId);
          if (!p) return null;
          const rawTotal = scores.reduce((sum, s) => sum + (s.total_score || 0), 0);
          const averageScore = scores.length > 0 ? rawTotal / scores.length : 0;
          return {
            participant: p,
            ballotCount: scores.length,
            rawTotal,
            averageScore,
          };
        })
        .filter((item): item is Omit<ParticipantStanding, 'rank' | 'isTied'> => item !== null)
        .sort((a, b) => b.averageScore - a.averageScore || b.rawTotal - a.rawTotal);

      // Step 2: Strict Competition Ranking with Shared Tie Ranks
      const standings: ParticipantStanding[] = [];
      for (let i = 0; i < unranked.length; i++) {
        const current = unranked[i];
        let rank = i + 1;
        let isTied = false;

        if (i > 0) {
          const prev = unranked[i - 1];
          if (Math.abs(current.averageScore - prev.averageScore) < 0.001) {
            rank = standings[i - 1].rank;
            isTied = true;
            standings[i - 1].isTied = true;
          }
        }
        standings.push({ ...current, rank, isTied });
      }

      return {
        event: ev,
        standings,
      };
    });
  }, [events, allScores, participantMap]);

  // --- SECTION C DERIVATIONS: ABSENTEES ---
  const absenteesList = useMemo(() => {
    const list: Array<{
      event: SupabaseEvent;
      participant: SupabaseParticipant;
      reason: string;
    }> = [];

    // Checked participants in ended events
    events.filter((e) => e.status === 'ended').forEach((ev) => {
      const assignedIds: string[] = (ev as any).assigned_participants || [];
      const evScores = allScores.filter((s) => s.event_id === ev.id);

      assignedIds.forEach((pId) => {
        const pScores = evScores.filter((s) => s.participant_id === pId);
        const p = participantMap.get(pId);
        if (!p) return;

        if (pScores.length === 0) {
          list.push({
            event: ev,
            participant: p,
            reason: 'Never Evaluated (No Ballots Submitted)',
          });
        } else {
          const totalPoints = pScores.reduce((sum, s) => sum + (s.total_score || 0), 0);
          if (totalPoints === 0) {
            list.push({
              event: ev,
              participant: p,
              reason: 'Zero Marks Recorded Across All Ballots',
            });
          }
        }
      });
    });

    return list;
  }, [events, allScores, participantMap]);

  // --- SECTION C DERIVATIONS: JUDGE BIAS METER ---
  const globalMean = useMemo(() => {
    if (allScores.length === 0) return 0;
    return allScores.reduce((sum, s) => sum + (s.total_score || 0), 0) / allScores.length;
  }, [allScores]);

  const judgeBiasMetrics = useMemo(() => {
    if (globalMean === 0) return [];
    return judges
      .map((j) => {
        const jScores = allScores.filter((s) => s.judge_id === j.id);
        if (jScores.length === 0) return null;
        const jMean = jScores.reduce((sum, s) => sum + (s.total_score || 0), 0) / jScores.length;
        const variancePct = ((jMean - globalMean) / globalMean) * 100;
        return {
          judge: j,
          ballotCount: jScores.length,
          mean: jMean,
          variancePct,
          classification:
            variancePct >= 10
              ? 'Lenient'
              : variancePct <= -10
              ? 'Strict'
              : 'Balanced',
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => Math.abs(b.variancePct) - Math.abs(a.variancePct));
  }, [judges, allScores, globalMean]);

  // --- SECTION C DERIVATIONS: CONSENSUS ANOMALIES ---
  const consensusAnomalies = useMemo(() => {
    const flags: Array<{
      id: string;
      event: SupabaseEvent;
      participant: SupabaseParticipant;
      highJudge: SupabaseJudge;
      lowJudge: SupabaseJudge;
      highScore: number;
      lowScore: number;
      delta: number;
    }> = [];

    const grouped = new Map<string, SupabaseScore[]>();
    allScores.forEach((s) => {
      const key = `${s.event_id}__${s.participant_id}`;
      const arr = grouped.get(key) || [];
      arr.push(s);
      grouped.set(key, arr);
    });

    grouped.forEach((scores) => {
      if (scores.length < 2) return;
      const sorted = [...scores].sort((a, b) => (b.total_score || 0) - (a.total_score || 0));
      const highest = sorted[0];
      const lowest = sorted[sorted.length - 1];

      const highScore = highest.total_score || 0;
      const lowScore = lowest.total_score || 0;
      const delta = highScore - lowScore;

      // Discrepancy threshold: difference >= 15 pts or relative deviation >= 30%
      if (delta >= 15 || (lowScore > 0 && delta / lowScore >= 0.35)) {
        const ev = eventMap.get(highest.event_id);
        const p = participantMap.get(highest.participant_id);
        const jHigh = judgeMap.get(highest.judge_id);
        const jLow = judgeMap.get(lowest.judge_id);

        if (ev && p && jHigh && jLow && jHigh.id !== jLow.id) {
          flags.push({
            id: `${highest.id}_${lowest.id}`,
            event: ev,
            participant: p,
            highJudge: jHigh,
            lowJudge: jLow,
            highScore,
            lowScore,
            delta,
          });
        }
      }
    });

    return flags.sort((a, b) => b.delta - a.delta);
  }, [allScores, eventMap, participantMap, judgeMap]);

  // --- SECTION D DERIVATIONS: FILTERED LOGS ---
  const filteredScores = useMemo(() => {
    return allScores
      .filter((s) => {
        if (selectedEventFilter !== 'all' && s.event_id !== selectedEventFilter) return false;
        if (selectedJudgeFilter !== 'all' && s.judge_id !== selectedJudgeFilter) return false;
        if (searchAudit.trim()) {
          const q = searchAudit.toLowerCase();
          const p = participantMap.get(s.participant_id);
          const j = judgeMap.get(s.judge_id);
          const e = eventMap.get(s.event_id);
          const pName = p ? p.name.toLowerCase() : '';
          const jName = j ? j.name.toLowerCase() : '';
          const eName = e ? e.name.toLowerCase() : '';
          if (!pName.includes(q) && !jName.includes(q) && !eName.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [allScores, selectedEventFilter, selectedJudgeFilter, searchAudit, participantMap, judgeMap, eventMap]);

  // ========================================================
  // PART 3: UNIFIED EXPORT ENGINE (PDF & EXCEL HEADERS)
  // ========================================================

  // Master Excel Generator with strict 5-row header
  const exportToExcelWithMasterHeader = (
    fileNamePrefix: string,
    sheetName: string,
    dataHeaders: string[],
    dataRows: (string | number)[][]
  ) => {
    const masterRows = [
      ['FAIR JUDGE - OFFICIAL REPORT'],
      ['Engineered by Sahil Kumar Rout'],
      [`Organization: ${organization.name}`],
      [`Org ID: ${organization.org_id}`],
      [''], // Blank row 5 for spacing
      dataHeaders, // Row 6
      ...dataRows, // Row 7+
    ];

    const ws = XLSX.utils.aoa_to_sheet(masterRows);

    // Apply auto-column widths
    const colWidths = dataHeaders.map((h, i) => {
      let maxLen = h.length;
      dataRows.forEach((r) => {
        const valStr = String(r[i] ?? '');
        if (valStr.length > maxLen) maxLen = valStr.length;
      });
      return { wch: Math.min(Math.max(maxLen + 3, 12), 40) };
    });
    ws['!cols'] = colWidths;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    XLSX.writeFile(wb, `${fileNamePrefix}_${organization.org_id}.xlsx`);
  };

  // Master PDF Generator with window.open (no blocked iframes)
  const exportToPDFWithMasterHeader = (reportTitle: string, contentHtml: string) => {
    const escapeHtml = (str: string) =>
      String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const htmlDocument = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(organization.name)} - ${escapeHtml(reportTitle)}</title>
        <style>
          @page { margin: 12mm; size: A4 portrait; }
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background: #ffffff !important;
            color: #111827 !important;
            padding: 0;
            margin: 0;
            line-height: 1.4;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .premium-header { 
            background: #ffffff; 
            color: #111827;
            padding: 0 0 12px 0;
            margin-bottom: 16px;
            border-bottom: 2px solid #10b981;
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
          }
          .header-left { display: flex; flex-direction: column; gap: 2px; }
          .brand { font-size: 14px; font-weight: 900; color: #10b981; display: flex; align-items: center; gap: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
          .dev-brand { font-size: 8px; font-family: ui-monospace, SFMono-Regular, monospace; color: #6b7280; text-transform: uppercase; }
          .header-center { text-align: center; flex: 1; padding: 0 16px; }
          .org-name { font-size: 20px; font-weight: 900; color: #111827; text-transform: uppercase; letter-spacing: -0.5px; line-height: 1.1; }
          .report-type { font-size: 10px; font-weight: 700; color: #4b5563; margin-top: 4px; letter-spacing: 1px; text-transform: uppercase; }
          .header-right { text-align: right; display: flex; flex-direction: column; gap: 2px; }
          .org-id-label { font-size: 8px; font-weight: 800; color: #9ca3af; text-transform: uppercase; }
          .org-id-val { font-size: 12px; font-family: ui-monospace, SFMono-Regular, monospace; font-weight: 900; color: #111827; }
          .content-wrapper { 
            padding: 0; 
          }
          .section-block {
            margin-bottom: 24px;
            page-break-inside: avoid;
            break-inside: avoid;
          }
          .section-title {
            font-size: 14px;
            font-weight: 800;
            color: #09090b;
            border-bottom: 1.5px solid #e4e4e7;
            padding-bottom: 4px;
            margin-bottom: 10px;
            text-transform: uppercase;
          }
          .jury-legend {
            font-size: 10px;
            font-family: monospace;
            color: #52525b;
            margin-bottom: 8px;
            background: #f4f4f5 !important;
            padding: 6px 10px;
            border-radius: 4px;
            border: 1px solid #e4e4e7;
            -webkit-print-color-adjust: exact;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            font-size: 11px;
            margin-bottom: 12px;
          }
          th {
            background: #f4f4f5 !important;
            border: 1px solid #d4d4d8;
            padding: 6px 8px;
            text-align: left;
            font-size: 9px;
            font-weight: 800;
            text-transform: uppercase;
            color: #27272a !important;
            -webkit-print-color-adjust: exact;
          }
          td {
            border: 1px solid #e4e4e7;
            padding: 6px 8px;
            color: #18181b;
          }
          .rank-gold { color: #b45309; font-weight: 900; }
          .rank-silver { color: #4b5563; font-weight: 900; }
          .rank-bronze { color: #92400e; font-weight: 900; }
        </style>
      </head>
      <body>
        <div class="premium-header">
          <!-- LEFT: App Branding -->
          <div class="header-left">
            <div class="brand">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></svg>
              Fair Judge
            </div>
            <div class="dev-brand">Engineered by Sahil Kumar Rout</div>
          </div>

          <!-- CENTER: Organization & Report Context -->
          <div class="header-center">
            <div class="org-name">${escapeHtml(organization.name)}</div>
            <div class="report-type">${escapeHtml(reportTitle)}</div>
          </div>

          <!-- RIGHT: Identifiers -->
          <div class="header-right">
            <div class="org-id-label">Organization ID</div>
            <div class="org-id-val">${escapeHtml(organization.org_id)}</div>
          </div>
        </div>

        <div class="content-wrapper">
          ${contentHtml}
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

  // --- EXPORT HANDLERS FOR EACH PILLAR ---

  // 1. RESULTS EXPORT (Concluded Events Only)
  const handleExportResultsPDF = () => {
    const concludedEvents = eventStandings.filter(
      (es) => es.event.status === 'ended' || es.event.status === 'archived'
    );

    if (concludedEvents.length === 0) {
      exportToPDFWithMasterHeader(
        'Official Results & Podium Standings',
        '<div style="padding: 32px; text-align: center; color: #71717a; font-size: 13px;">No events have concluded yet. Results and podium standings will be securely generated here once a live session ends.</div>'
      );
      return;
    }

    const content = concludedEvents
      .filter((es) => es.standings.length > 0)
      .map(({ event, standings }) => {
        const top3 = standings.filter((s) => s.rank <= 3);
        const rows = top3
          .map(
            (s) => `
            <tr>
              <td class="${s.rank === 1 ? 'rank-gold' : s.rank === 2 ? 'rank-silver' : 'rank-bronze'}">
                ${s.rank === 1 ? '1st 🥇' : s.rank === 2 ? '2nd 🥈' : '3rd 🥉'}${s.isTied ? ' (Tied)' : ''}
              </td>
              <td style="font-family: monospace; font-weight: bold;">${s.participant.identity_id || `P-${s.participant.sl_no || '0000'}`}</td>
              <td style="font-weight: 700;">${s.participant.name}</td>
              <td>${s.participant.school || 'Independent'}</td>
              <td>${s.participant.class_or_age || '—'}</td>
              <td style="text-align: right; font-family: monospace; font-weight: bold; color: #059669;">
                ${s.averageScore.toFixed(2)} pts
              </td>
            </tr>
          `
          )
          .join('');

        return `
          <div class="section-block">
            <div class="section-title">
              ${(event as any).category ? `${(event as any).category} — ` : ''}${event.name}
            </div>
            <table>
              <thead>
                <tr>
                  <th style="width: 80px;">Podium</th>
                  <th style="width: 100px;">Participant ID</th>
                  <th>Competitor Name</th>
                  <th>School / Institution</th>
                  <th>Category</th>
                  <th style="width: 90px; text-align: right;">Final Score</th>
                </tr>
              </thead>
              <tbody>
                ${rows || '<tr><td colspan="6" style="text-align: center; color: #71717a;">No podium records</td></tr>'}
              </tbody>
            </table>
          </div>
        `;
      })
      .join('');

    exportToPDFWithMasterHeader('Official Results & Podium Standings', content);
  };

  const handleExportResultsExcel = () => {
    const concludedEvents = eventStandings.filter(
      (es) => es.event.status === 'ended' || es.event.status === 'archived'
    );

    const headers = [
      'Event Name',
      'Category',
      'Rank',
      'Tied',
      'Participant ID',
      'Participant Name',
      'School / Institution',
      'Class/Grade/Age',
      'Final Average Score',
      'Ballots Count',
    ];

    const rows: (string | number)[][] = [];
    concludedEvents.forEach(({ event, standings }) => {
      standings.forEach((s) => {
        rows.push([
          event.name,
          (event as any).category || 'General',
          s.rank,
          s.isTied ? 'YES' : 'NO',
          s.participant.identity_id || `P-${s.participant.sl_no || '0000'}`,
          s.participant.name,
          s.participant.school || 'Independent',
          s.participant.class_or_age || '',
          s.averageScore.toFixed(2),
          s.ballotCount,
        ]);
      });
    });

    exportToExcelWithMasterHeader('FairJudge_Results', 'Results_Podium', headers, rows);
  };

  // 2. STATS EXPORT (Smart Scorecard Matrix with Jury Legend)
  const handleExportStatsPDF = () => {
    const content = eventStandings.map(({ event, standings }) => {
      const evScores = allScores.filter((s) => s.event_id === event.id);
      const evJudges = judges.filter((j) => evScores.some((s) => s.judge_id === j.id));

      // 1. The Jury Legend
      const juryLegend = evJudges.length > 0
        ? `JURY PANEL: ` + evJudges.map((j, idx) => `J${idx + 1}: ${j.name} (${j.judge_id || j.id.slice(0, 5)})`).join(' • ')
        : 'JURY PANEL: No judges evaluated yet';

      // 2. Dynamic Table Headers: Rank | ID | Participant | Institution | J1 | J2 | ... | Final Score
      const judgeHeaderCols = evJudges
        .map((_, idx) => `<th style="text-align: center; width: 44px;">J${idx + 1}</th>`)
        .join('');

      // 3. The Data Rows with centered judge scores
      const rows = standings
        .map((s) => {
          const judgeCells = evJudges
            .map((j) => {
              const scoreObj = evScores.find(
                (sc) => sc.event_id === event.id && sc.participant_id === s.participant.id && sc.judge_id === j.id
              );
              return `<td style="text-align: center; font-family: monospace;">${scoreObj ? scoreObj.total_score : '—'}</td>`;
            })
            .join('');

          return `
            <tr>
              <td style="font-weight: bold; text-align: center;">#${s.rank}${s.isTied ? ' (T)' : ''}</td>
              <td style="font-family: monospace; font-size: 10px;">${s.participant.identity_id || `P-${s.participant.sl_no || ''}`}</td>
              <td style="font-weight: 700;">${s.participant.name}</td>
              <td>${s.participant.school || 'Independent'}</td>
              ${judgeCells}
              <td style="text-align: center; font-weight: bold; font-family: monospace; color: #059669;">
                ${s.averageScore.toFixed(2)}
              </td>
            </tr>
          `;
        })
        .join('');

      return `
        <div class="section-block">
          <div class="section-title">
            ${(event as any).category ? `${(event as any).category} — ` : ''}${event.name}
          </div>
          <div class="jury-legend">
            ${juryLegend}
          </div>
          <table>
            <thead>
              <tr>
                <th style="width: 50px; text-align: center;">Rank</th>
                <th style="width: 85px;">ID</th>
                <th>Participant</th>
                <th>Institution</th>
                ${judgeHeaderCols}
                <th style="width: 75px; text-align: center;">Final Score</th>
              </tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="${5 + evJudges.length}" style="text-align: center; color: #71717a;">No scoring records yet</td></tr>`}
            </tbody>
          </table>
        </div>
      `;
    }).join('');

    exportToPDFWithMasterHeader('Master Scorecard & Jury Ballot Stats', content);
  };

  const handleExportStatsExcel = () => {
    const masterAoa: (string | number)[][] = [
      ['FAIR JUDGE - OFFICIAL REPORT'],
      ['Engineered by Sahil Kumar Rout'],
      [`Organization: ${organization.name}`],
      [`Org ID: ${organization.org_id}`],
      [''], // Blank row 5 for spacing
    ];

    eventStandings.forEach(({ event, standings }) => {
      const evScores = allScores.filter((s) => s.event_id === event.id);
      const evJudges = judges.filter((j) => evScores.some((s) => s.judge_id === j.id));

      const eventTitle = `${(event as any).category ? `${(event as any).category} — ` : ''}${event.name}`;
      const juryLegend = evJudges.length > 0
        ? `JURY PANEL: ` + evJudges.map((j, idx) => `J${idx + 1}: ${j.name} (${j.judge_id || j.id.slice(0, 5)})`).join(' • ')
        : 'JURY PANEL: No judges evaluated yet';

      masterAoa.push([`EVENT: ${eventTitle}`]);
      masterAoa.push([juryLegend]);

      const headers = [
        'Rank',
        'ID',
        'Participant',
        'Institution',
        ...evJudges.map((_, idx) => `J${idx + 1}`),
        'Final Score',
      ];
      masterAoa.push(headers);

      if (standings.length === 0) {
        masterAoa.push(['—', '—', 'No scoring records yet', '—', ...evJudges.map(() => '—'), '—']);
      } else {
        standings.forEach((s) => {
          const judgeScores = evJudges.map((j) => {
            const sc = evScores.find(
              (score) =>
                score.event_id === event.id &&
                score.participant_id === s.participant.id &&
                score.judge_id === j.id
            );
            return sc ? sc.total_score : '—';
          });

          masterAoa.push([
            s.rank,
            s.participant.identity_id || `P-${s.participant.sl_no || ''}`,
            s.participant.name,
            s.participant.school || 'Independent',
            ...judgeScores,
            Number(s.averageScore.toFixed(2)),
          ]);
        });
      }

      // Spacing between events
      masterAoa.push(['']);
    });

    const ws = XLSX.utils.aoa_to_sheet(masterAoa);
    ws['!cols'] = [
      { wch: 8 },  // Rank
      { wch: 14 }, // ID
      { wch: 25 }, // Participant
      { wch: 25 }, // Institution
      { wch: 10 }, // J1
      { wch: 10 }, // J2
      { wch: 10 }, // J3
      { wch: 10 }, // J4
      { wch: 10 }, // J5
      { wch: 10 }, // J6
      { wch: 14 }, // Final Score
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Scorecard_Matrix');
    XLSX.writeFile(wb, `FairJudge_Master_Scorecard_${organization.org_id}.xlsx`);
  };

  // 3. ANALYTICS EXPORT
  const handleExportAnalyticsPDF = () => {
    const absenteesHtml = absenteesList.length === 0
      ? '<p style="font-size: 11px; color: #71717a;">Zero absentees recorded across all completed events.</p>'
      : `
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Participant ID</th>
              <th>Competitor Name</th>
              <th>Institution</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            ${absenteesList
              .map(
                (a) => `
              <tr>
                <td>${a.event.name}</td>
                <td style="font-family: monospace;">${a.participant.identity_id || `P-${a.participant.sl_no}`}</td>
                <td style="font-weight: 700;">${a.participant.name}</td>
                <td>${a.participant.school}</td>
                <td style="color: #dc2626;">${a.reason}</td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      `;

    const biasHtml = judgeBiasMetrics.length === 0
      ? '<p style="font-size: 11px; color: #71717a;">Insufficient jury score data.</p>'
      : `
        <table>
          <thead>
            <tr>
              <th>Judge ID</th>
              <th>Judge Name</th>
              <th>Ballots Submitted</th>
              <th>Average Score</th>
              <th>Consensus Variance</th>
              <th>Integrity Status</th>
            </tr>
          </thead>
          <tbody>
            ${judgeBiasMetrics
              .map(
                (b) => `
              <tr>
                <td style="font-family: monospace;">${b.judge.judge_id || b.judge.id.slice(0, 6)}</td>
                <td style="font-weight: 700;">${b.judge.name}</td>
                <td>${b.ballotCount}</td>
                <td style="font-family: monospace;">${b.mean.toFixed(2)} pts</td>
                <td style="font-family: monospace; font-weight: bold; color: ${b.variancePct >= 10 ? '#d97706' : b.variancePct <= -10 ? '#2563eb' : '#059669'};">
                  ${b.variancePct >= 0 ? '+' : ''}${b.variancePct.toFixed(1)}%
                </td>
                <td>${b.classification.toUpperCase()}</td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      `;

    const anomaliesHtml = consensusAnomalies.length === 0
      ? '<p style="font-size: 11px; color: #71717a;">Zero consensus discrepancies detected.</p>'
      : `
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Competitor</th>
              <th>Higher Evaluation</th>
              <th>Lower Evaluation</th>
              <th>Delta Difference</th>
            </tr>
          </thead>
          <tbody>
            ${consensusAnomalies
              .map(
                (anom) => `
              <tr>
                <td>${anom.event.name}</td>
                <td style="font-weight: 700;">${anom.participant.name} (${anom.participant.identity_id || `P-${anom.participant.sl_no}`})</td>
                <td>${anom.highJudge.name}: <strong>${anom.highScore} pts</strong></td>
                <td>${anom.lowJudge.name}: <strong>${anom.lowScore} pts</strong></td>
                <td style="color: #ea580c; font-weight: bold; font-family: monospace;">+${anom.delta.toFixed(1)} pts gap</td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      `;

    const content = `
      <div class="section-block">
        <div class="section-title">1. Absentee Competitor Ledger</div>
        ${absenteesHtml}
      </div>
      <div class="section-block">
        <div class="section-title">2. Jury Bias &amp; Scoring Calibration Analysis</div>
        ${biasHtml}
      </div>
      <div class="section-block">
        <div class="section-title">3. Consensus Scoring Anomalies</div>
        ${anomaliesHtml}
      </div>
    `;

    exportToPDFWithMasterHeader('Jury Integrity & Competitor Analytics', content);
  };

  const handleExportAnalyticsExcel = () => {
    const headers = [
      'Report Section',
      'Record ID / Code',
      'Event / Entity',
      'Participant Name',
      'Judge / Reason',
      'Metric Value',
      'Status / Delta',
    ];

    const rows: (string | number)[][] = [];

    // Absentees
    absenteesList.forEach((a) => {
      rows.push([
        'Absentee Competitor',
        a.participant.identity_id || `P-${a.participant.sl_no || ''}`,
        a.event.name,
        a.participant.name,
        a.reason,
        '0 pts',
        'ABSENT',
      ]);
    });

    // Bias
    judgeBiasMetrics.forEach((b) => {
      rows.push([
        'Judge Calibration',
        b.judge.judge_id || b.judge.id.slice(0, 6),
        'Jury Member',
        '—',
        b.judge.name,
        `${b.mean.toFixed(2)} pts (Mean)`,
        `${b.variancePct >= 0 ? '+' : ''}${b.variancePct.toFixed(1)}% (${b.classification})`,
      ]);
    });

    // Anomalies
    consensusAnomalies.forEach((c) => {
      rows.push([
        'Consensus Anomaly',
        c.participant.identity_id || `P-${c.participant.sl_no || ''}`,
        c.event.name,
        c.participant.name,
        `${c.highJudge.name} (${c.highScore}) vs ${c.lowJudge.name} (${c.lowScore})`,
        `${c.delta.toFixed(1)} pts`,
        'DISCREPANCY',
      ]);
    });

    exportToExcelWithMasterHeader('FairJudge_Analytics_Report', 'Analytics_Integrity', headers, rows);
  };

  // 4. LOGS EXPORT
  const handleExportLogsPDF = () => {
    const content = `
      <div class="section-block">
        <div class="section-title">Official Cryptographic Ballot Commit Log (${filteredScores.length} Entries)</div>
        <table>
          <thead>
            <tr>
              <th style="width: 110px;">Timestamp</th>
              <th style="width: 70px;">Commit ID</th>
              <th>Event</th>
              <th>Judge</th>
              <th>Participant</th>
              <th style="width: 80px; text-align: right;">Score</th>
            </tr>
          </thead>
          <tbody>
            ${filteredScores
              .map((s) => {
                const p = participantMap.get(s.participant_id);
                const j = judgeMap.get(s.judge_id);
                const e = eventMap.get(s.event_id);
                return `
                <tr>
                  <td style="font-family: monospace; font-size: 10px;">${new Date(s.created_at).toLocaleTimeString()}</td>
                  <td style="font-family: monospace; color: #059669; font-weight: bold;">#${s.id.slice(0, 6).toUpperCase()}</td>
                  <td>${e?.name || s.event_id}</td>
                  <td style="font-weight: 600;">${j?.name || s.judge_id}</td>
                  <td>${p?.name || s.participant_id}</td>
                  <td style="text-align: right; font-weight: bold; font-family: monospace; color: #059669;">
                    ${s.total_score} pts
                  </td>
                </tr>
              `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;

    exportToPDFWithMasterHeader('Official Cryptographic Ledger Logs', content);
  };

  const handleExportLogsExcel = () => {
    const headers = [
      'Timestamp',
      'Commit Hash ID',
      'Event Name',
      'Category',
      'Judge Name',
      'Judge ID Code',
      'Participant ID',
      'Participant Name',
      'School / Institution',
      'Total Score Committed',
      'Score Breakdown Criteria',
    ];

    const rows = filteredScores.map((s) => {
      const p = participantMap.get(s.participant_id);
      const j = judgeMap.get(s.judge_id);
      const e = eventMap.get(s.event_id);
      return [
        new Date(s.created_at).toLocaleString(),
        `#${s.id.slice(0, 8).toUpperCase()}`,
        e?.name || s.event_id,
        (e as any)?.category || 'General',
        j?.name || s.judge_id,
        j?.judge_id || j?.id.slice(0, 6) || '—',
        p?.identity_id || `P-${p?.sl_no || ''}`,
        p?.name || s.participant_id,
        p?.school || '—',
        s.total_score,
        JSON.stringify(s.score_payload?.criteria || s.score_data || {}),
      ];
    });

    exportToExcelWithMasterHeader('FairJudge_Ledger_Logs', 'Cryptographic_Logs', headers, rows);
  };

  return (
    <div className="flex-1 overflow-y-auto relative pb-32">
      {/* ======================================================== */}
      {/* PART 1: THE 4-PILLAR STICKY NAVIGATION (Segmented Bar)    */}
      {/* ======================================================== */}
      <div className="sticky top-0 z-40 bg-stone-50/95 dark:bg-black/95 backdrop-blur-md pt-3 pb-3 px-4 border-b border-stone-200/80 dark:border-zinc-800/80 shadow-xs">
        <div className="flex w-full p-0.5 bg-stone-200/70 dark:bg-zinc-900 rounded-xl border border-stone-200/60 dark:border-zinc-800 shadow-inner">
          {/* Pillar 1: Results */}
          <button
            type="button"
            onClick={() => setActivePillar('results')}
            className={`flex-1 min-h-[38px] px-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center space-x-1.5 cursor-pointer ${
              activePillar === 'results'
                ? 'bg-white dark:bg-zinc-950 text-emerald-600 dark:text-emerald-400 shadow-sm border border-stone-200/60 dark:border-zinc-800'
                : 'text-stone-500 dark:text-zinc-400 hover:text-stone-900 dark:hover:text-white'
            }`}
          >
            <Trophy className="w-3.5 h-3.5 shrink-0" />
            <span>Results</span>
          </button>

          {/* Pillar 2: Stats */}
          <button
            type="button"
            onClick={() => setActivePillar('stats')}
            className={`flex-1 min-h-[38px] px-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center space-x-1.5 cursor-pointer ${
              activePillar === 'stats'
                ? 'bg-white dark:bg-zinc-950 text-blue-600 dark:text-blue-400 shadow-sm border border-stone-200/60 dark:border-zinc-800'
                : 'text-stone-500 dark:text-zinc-400 hover:text-stone-900 dark:hover:text-white'
            }`}
          >
            <Sliders className="w-3.5 h-3.5 shrink-0" />
            <span>Stats</span>
          </button>

          {/* Pillar 3: Analytics */}
          <button
            type="button"
            onClick={() => setActivePillar('analytics')}
            className={`flex-1 min-h-[38px] px-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center space-x-1.5 cursor-pointer ${
              activePillar === 'analytics'
                ? 'bg-white dark:bg-zinc-950 text-amber-600 dark:text-amber-400 shadow-sm border border-stone-200/60 dark:border-zinc-800'
                : 'text-stone-500 dark:text-zinc-400 hover:text-stone-900 dark:hover:text-white'
            }`}
          >
            <TrendingUp className="w-3.5 h-3.5 shrink-0" />
            <span>Analytics</span>
          </button>

          {/* Pillar 4: Logs */}
          <button
            type="button"
            onClick={() => setActivePillar('logs')}
            className={`flex-1 min-h-[38px] px-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center space-x-1.5 cursor-pointer ${
              activePillar === 'logs'
                ? 'bg-white dark:bg-zinc-950 text-stone-900 dark:text-zinc-100 shadow-sm border border-stone-200/60 dark:border-zinc-800'
                : 'text-stone-500 dark:text-zinc-400 hover:text-stone-900 dark:hover:text-white'
            }`}
          >
            <Clock className="w-3.5 h-3.5 shrink-0" />
            <span>Logs</span>
          </button>
        </div>
      </div>

      <div className="px-4 pt-3.5 space-y-4">
        {/* ======================================================== */}
        {/* SECTION A: RESULTS (The Podium View)                     */}
        {/* ======================================================== */}
        {activePillar === 'results' && (
          <div className="space-y-4 animate-in fade-in duration-200">
            {/* Header: Two massive export buttons */}
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={handleExportResultsPDF}
                className="min-h-[44px] px-3 bg-stone-900 hover:bg-stone-800 dark:bg-zinc-100 dark:hover:bg-white text-white dark:text-zinc-900 font-bold text-xs rounded-xl shadow-sm active:scale-95 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <Printer className="w-4 h-4 stroke-[2.2] text-emerald-500 dark:text-emerald-600" />
                <span>Export PDF (Results)</span>
              </button>

              <button
                type="button"
                onClick={handleExportResultsExcel}
                className="min-h-[44px] px-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl shadow-sm shadow-emerald-600/20 active:scale-95 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <FileSpreadsheet className="w-4 h-4 stroke-[2.2]" />
                <span>Download Excel (Results)</span>
              </button>
            </div>

            {/* Event List with Metallic Accented Podiums */}
            {eventStandings.filter((es) => es.event.status === 'ended' || es.event.status === 'archived').length === 0 ? (
              <div className="p-8 text-center bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 text-stone-500 text-xs">
                No events have concluded yet. Results and podium standings will be securely generated here once a live session ends.
              </div>
            ) : (
              eventStandings
                .filter((es) => es.event.status === 'ended' || es.event.status === 'archived')
                .map(({ event, standings }) => {
                  const podiumWinners = standings.filter((s) => s.rank <= 3);

                  return (
                    <div
                      key={event.id}
                      className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800/80 rounded-2xl p-4 sm:p-5 shadow-xs space-y-3.5"
                    >
                      {/* Event Title + Category Header */}
                      <div className="flex items-start justify-between gap-2 border-b border-stone-100 dark:border-zinc-800/80 pb-2.5">
                        <div>
                          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                            {(event as any).category || 'General Division'}
                          </span>
                          <h3 className="text-base font-black text-stone-900 dark:text-white">
                            {event.name}
                          </h3>
                        </div>
                        <span className="text-[10px] font-mono uppercase font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                          Concluded
                        </span>
                      </div>

                      {/* Podium Cards (1st, 2nd, 3rd) */}
                      {podiumWinners.length === 0 ? (
                        <div className="p-3 text-center text-xs text-stone-400 dark:text-zinc-500 italic">
                          No official scores committed yet for this lineup.
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          {podiumWinners.map((winner) => {
                            const isGold = winner.rank === 1;
                            const isSilver = winner.rank === 2;
                            const isBronze = winner.rank === 3;

                            return (
                              <div
                                key={winner.participant.id}
                                className={`rounded-xl p-3.5 border-2 flex flex-col justify-between space-y-2 transition-all ${
                                  isGold
                                    ? 'border-yellow-400 bg-yellow-400/5 dark:bg-yellow-400/10'
                                    : isSilver
                                    ? 'border-gray-400 bg-gray-400/5 dark:bg-gray-400/10'
                                    : 'border-amber-700 bg-amber-700/5 dark:bg-amber-700/10'
                                }`}
                              >
                                <div>
                                  <div className="flex items-center justify-between">
                                    <span
                                      className={`text-xs font-black uppercase tracking-wider flex items-center gap-1 ${
                                        isGold
                                          ? 'text-yellow-600 dark:text-yellow-400'
                                          : isSilver
                                          ? 'text-zinc-600 dark:text-zinc-300'
                                          : 'text-amber-700 dark:text-amber-500'
                                      }`}
                                    >
                                      {isGold ? '1st Place 🥇' : isSilver ? '2nd Place 🥈' : '3rd Place 🥉'}
                                      {winner.isTied && (
                                        <span className="text-[10px] font-mono font-bold px-1 rounded bg-stone-200 dark:bg-zinc-800 text-stone-600 dark:text-zinc-300">
                                          TIED
                                        </span>
                                      )}
                                    </span>
                                    <span className="text-[11px] font-mono font-bold px-1.5 py-0.5 rounded bg-white/80 dark:bg-black/50 border border-stone-200 dark:border-zinc-800 text-stone-700 dark:text-zinc-300">
                                      [ID: {winner.participant.identity_id || `P-${winner.participant.sl_no || '0000'}`}]
                                    </span>
                                  </div>

                                  <h4 className="text-sm font-black text-stone-900 dark:text-white mt-1.5 truncate">
                                    {winner.participant.name}
                                  </h4>
                                  <p className="text-xs text-stone-500 dark:text-zinc-400 truncate mt-0.5">
                                    {winner.participant.school}
                                  </p>
                                  {winner.participant.class_or_age && (
                                    <span className="text-[10px] font-mono text-stone-400 dark:text-zinc-500 block mt-0.5">
                                      {winner.participant.class_or_age}
                                    </span>
                                  )}
                                </div>

                                <div className="pt-2 border-t border-stone-200/50 dark:border-zinc-800 flex justify-between items-center text-xs">
                                  <span className="text-[10px] font-mono text-stone-400 dark:text-zinc-500">
                                    {winner.ballotCount} Ballots
                                  </span>
                                  <span className="font-mono font-black text-emerald-600 dark:text-emerald-400">
                                    {winner.averageScore.toFixed(2)} pts
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
            )}
          </div>
        )}

        {/* ======================================================== */}
        {/* SECTION B: STATS (The Master Scorecard)                  */}
        {/* ======================================================== */}
        {activePillar === 'stats' && (
          <div className="space-y-4 animate-in fade-in duration-200">
            {/* Header: Two massive export buttons */}
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={handleExportStatsPDF}
                className="min-h-[44px] px-3 bg-stone-900 hover:bg-stone-800 dark:bg-zinc-100 dark:hover:bg-white text-white dark:text-zinc-900 font-bold text-xs rounded-xl shadow-sm active:scale-95 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <Printer className="w-4 h-4 stroke-[2.2] text-blue-500 dark:text-blue-600" />
                <span>Export PDF (Stats)</span>
              </button>

              <button
                type="button"
                onClick={handleExportStatsExcel}
                className="min-h-[44px] px-3 bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs rounded-xl shadow-sm shadow-blue-600/20 active:scale-95 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <FileSpreadsheet className="w-4 h-4 stroke-[2.2]" />
                <span>Download Excel (Stats)</span>
              </button>
            </div>

            {/* Collapsible Event Accordions */}
            <div className="space-y-3">
              {eventStandings.map(({ event, standings }) => {
                const isExpanded = !!expandedEvents[event.id];
                const evScores = allScores.filter((s) => s.event_id === event.id);
                const evJudges = judges.filter((j) => evScores.some((s) => s.judge_id === j.id));

                return (
                  <div
                    key={event.id}
                    className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800/80 rounded-2xl overflow-hidden shadow-xs"
                  >
                    {/* Accordion Trigger */}
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedEvents((prev) => ({
                          ...prev,
                          [event.id]: !prev[event.id],
                        }))
                      }
                      className="w-full px-4 py-3.5 flex items-center justify-between text-left hover:bg-stone-50 dark:hover:bg-zinc-900/50 transition-colors cursor-pointer"
                    >
                      <div>
                        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">
                          {(event as any).category || 'General Division'}
                        </span>
                        <h4 className="text-sm font-bold text-stone-900 dark:text-white">
                          {event.name}
                        </h4>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-stone-100 dark:bg-zinc-900 text-stone-600 dark:text-zinc-400 font-bold border border-stone-200 dark:border-zinc-800">
                          {standings.length} Evaluated
                        </span>
                        {isExpanded ? (
                          <ChevronUp className="w-4 h-4 text-stone-400" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-stone-400" />
                        )}
                      </div>
                    </button>

                    {/* Accordion Expanded Content */}
                    {isExpanded && (
                      <div className="p-4 border-t border-stone-100 dark:border-zinc-800/80 space-y-4 bg-stone-50/40 dark:bg-zinc-900/20 animate-in fade-in">
                        {/* Top: Active Judges who scored this event */}
                        <div>
                          <span className="text-[10px] font-bold uppercase tracking-wider text-stone-400 dark:text-zinc-500 block mb-1.5">
                            Evaluating Judges Panel ({evJudges.length})
                          </span>
                          {evJudges.length === 0 ? (
                            <span className="text-xs text-stone-400 italic">No judge submissions yet</span>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              {evJudges.map((j, idx) => (
                                <span
                                  key={j.id}
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-xs font-semibold text-stone-800 dark:text-zinc-200 shadow-2xs"
                                >
                                  <span className="font-mono font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded text-[10px]">
                                    J{idx + 1}
                                  </span>
                                  <span>{j.name}</span>
                                  <span className="font-mono text-[10px] text-stone-400">
                                    ({j.judge_id || j.id.slice(0, 5)})
                                  </span>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Bottom: Horizontal-Scrolling Master Score Table */}
                        <div className="border border-stone-200 dark:border-zinc-800 rounded-xl overflow-x-auto bg-white dark:bg-zinc-950">
                          <table className="w-full text-left text-xs min-w-[550px]">
                            <thead className="bg-stone-100 dark:bg-zinc-900 text-stone-700 dark:text-zinc-300 font-bold border-b border-stone-200 dark:border-zinc-800 text-[11px]">
                              <tr>
                                <th className="p-2.5 w-16 text-center">Rank</th>
                                <th className="p-2.5 w-24">ID</th>
                                <th className="p-2.5">Participant</th>
                                <th className="p-2.5">Institution</th>
                                {evJudges.map((_, idx) => (
                                  <th key={idx} className="p-2.5 text-center font-mono w-14">
                                    J{idx + 1}
                                  </th>
                                ))}
                                <th className="p-2.5 text-right font-bold w-20">Total</th>
                                <th className="p-2.5 text-right font-bold w-20">Avg Pts</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-stone-200 dark:divide-zinc-800">
                              {standings.length === 0 ? (
                                <tr>
                                  <td colSpan={6 + evJudges.length} className="p-4 text-center text-stone-400">
                                    No scores committed for this event yet.
                                  </td>
                                </tr>
                              ) : (
                                standings.map((s) => (
                                  <tr key={s.participant.id} className="hover:bg-stone-50 dark:hover:bg-zinc-900/50">
                                    <td className="p-2.5 font-bold font-mono text-center">
                                      #{s.rank}
                                      {s.isTied && (
                                        <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-stone-200 dark:bg-zinc-800 text-stone-600 dark:text-zinc-300">
                                          TIE
                                        </span>
                                      )}
                                    </td>
                                    <td className="p-2.5 font-mono text-[11px] text-stone-500 dark:text-zinc-400">
                                      {s.participant.identity_id || `P-${s.participant.sl_no || ''}`}
                                    </td>
                                    <td className="p-2.5 font-bold text-stone-900 dark:text-white">
                                      {s.participant.name}
                                    </td>
                                    <td className="p-2.5 text-stone-500 dark:text-zinc-400 truncate max-w-[140px]">
                                      {s.participant.school}
                                    </td>
                                    {evJudges.map((j) => {
                                      const sc = evScores.find(
                                        (score) =>
                                          score.event_id === event.id &&
                                          score.participant_id === s.participant.id &&
                                          score.judge_id === j.id
                                      );
                                      return (
                                        <td
                                          key={j.id}
                                          className="p-2.5 text-center font-mono text-stone-700 dark:text-zinc-300"
                                        >
                                          {sc ? sc.total_score : '—'}
                                        </td>
                                      );
                                    })}
                                    <td className="p-2.5 text-right font-mono font-bold text-stone-900 dark:text-white">
                                      {s.rawTotal}
                                    </td>
                                    <td className="p-2.5 text-right font-mono font-black text-emerald-600 dark:text-emerald-400">
                                      {s.averageScore.toFixed(2)}
                                    </td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* SECTION C: ANALYTICS (The Integrity Engine)              */}
        {/* ======================================================== */}
        {activePillar === 'analytics' && (
          <div className="space-y-4 animate-in fade-in duration-200">
            {/* Header: Two massive export buttons */}
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={handleExportAnalyticsPDF}
                className="min-h-[44px] px-3 bg-stone-900 hover:bg-stone-800 dark:bg-zinc-100 dark:hover:bg-white text-white dark:text-zinc-900 font-bold text-xs rounded-xl shadow-sm active:scale-95 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <Printer className="w-4 h-4 stroke-[2.2] text-amber-500 dark:text-amber-600" />
                <span>Export PDF (Analytics)</span>
              </button>

              <button
                type="button"
                onClick={handleExportAnalyticsExcel}
                className="min-h-[44px] px-3 bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs rounded-xl shadow-sm shadow-amber-600/20 active:scale-95 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <FileSpreadsheet className="w-4 h-4 stroke-[2.2]" />
                <span>Download Excel (Analytics)</span>
              </button>
            </div>

            {/* 1. Absentee Tracker */}
            <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800/80 rounded-2xl p-4 sm:p-5 shadow-xs space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <UserX className="w-4 h-4 text-rose-500" />
                  <h3 className="text-sm font-bold text-stone-900 dark:text-white">
                    Absentee Competitor Tracker
                  </h3>
                </div>
                <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-md bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20">
                  {absenteesList.length} Flagged
                </span>
              </div>

              {absenteesList.length === 0 ? (
                <div className="p-4 rounded-xl bg-emerald-500/5 dark:bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 shrink-0" />
                  <span>Zero absentees recorded. All scheduled participants were evaluated.</span>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {absenteesList.map((a, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-rose-500/30 space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-stone-900 dark:text-white truncate">
                          {a.participant.name}
                        </span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-600 dark:text-rose-400 font-bold">
                          [ID: {a.participant.identity_id || `P-${a.participant.sl_no}`}]
                        </span>
                      </div>
                      <p className="text-[11px] text-stone-500 dark:text-zinc-400 truncate">
                        {a.event.name} • {a.participant.school}
                      </p>
                      <p className="text-[10px] font-mono text-rose-600 dark:text-rose-400 font-medium">
                        {a.reason}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 2. Judge Bias Meter */}
            <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800/80 rounded-2xl p-4 sm:p-5 shadow-xs space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Scale className="w-4 h-4 text-amber-500" />
                  <h3 className="text-sm font-bold text-stone-900 dark:text-white">
                    Jury Calibration &amp; Bias Meter
                  </h3>
                </div>
                <span className="text-xs font-mono text-stone-500 dark:text-zinc-400">
                  Jury Mean: <strong className="text-stone-900 dark:text-white">{globalMean.toFixed(1)} pts</strong>
                </span>
              </div>

              {judgeBiasMetrics.length === 0 ? (
                <div className="p-4 text-center text-xs text-stone-400">
                  Not enough scoring data to calibrate jury tendencies.
                </div>
              ) : (
                <div className="space-y-3">
                  {judgeBiasMetrics.map((bm) => {
                    // Meter percentage: center is 0, clamped between -30% and +30%
                    const clampedVariance = Math.max(-30, Math.min(30, bm.variancePct));
                    // Convert -30..+30 to 0..100%
                    const meterPosition = ((clampedVariance + 30) / 60) * 100;

                    return (
                      <div
                        key={bm.judge.id}
                        className="p-3.5 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 space-y-2"
                      >
                        <div className="flex items-center justify-between text-xs">
                          <div>
                            <span className="font-bold text-stone-900 dark:text-white mr-2">
                              {bm.judge.name}
                            </span>
                            <span className="text-[10px] font-mono text-stone-400">
                              [ID: {bm.judge.judge_id || bm.judge.id.slice(0, 6)}]
                            </span>
                          </div>
                          <span
                            className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-md ${
                              bm.classification === 'Lenient'
                                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                                : bm.classification === 'Strict'
                                ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20'
                                : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                            }`}
                          >
                            {bm.variancePct >= 0 ? '+' : ''}
                            {bm.variancePct.toFixed(1)}% ({bm.classification})
                          </span>
                        </div>

                        {/* Dual-Sided Visual Meter */}
                        <div className="relative pt-1 pb-1">
                          <div className="h-2 w-full rounded-full bg-stone-200 dark:bg-zinc-800 relative overflow-hidden">
                            {/* Center mark indicator (0%) */}
                            <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-stone-400 dark:bg-zinc-600 z-10" />
                          </div>
                          {/* Moving indicator pin */}
                          <div
                            className={`absolute top-0 w-3 h-4 rounded-sm border shadow-xs transform -translate-x-1/2 transition-all ${
                              bm.classification === 'Lenient'
                                ? 'bg-amber-500 border-amber-600'
                                : bm.classification === 'Strict'
                                ? 'bg-blue-500 border-blue-600'
                                : 'bg-emerald-500 border-emerald-600'
                            }`}
                            style={{ left: `${meterPosition}%` }}
                          />
                        </div>

                        <div className="flex justify-between text-[10px] font-mono text-stone-400 dark:text-zinc-500">
                          <span>-30% Strict</span>
                          <span>Balanced Consensus</span>
                          <span>+30% Lenient</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 3. Consensus Anomalies */}
            <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800/80 rounded-2xl p-4 sm:p-5 shadow-xs space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <ShieldAlert className="w-4 h-4 text-orange-500" />
                  <h3 className="text-sm font-bold text-stone-900 dark:text-white">
                    Consensus Scoring Anomalies
                  </h3>
                </div>
                <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-md bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20">
                  {consensusAnomalies.length} Flagged
                </span>
              </div>

              {consensusAnomalies.length === 0 ? (
                <div className="p-4 rounded-xl bg-emerald-500/5 dark:bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 shrink-0" />
                  <span>Jury consensus is high across all stages with zero severe score discrepancies.</span>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {consensusAnomalies.map((anom) => (
                    <div
                      key={anom.id}
                      className="p-3.5 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-orange-500/30 space-y-1.5"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-stone-900 dark:text-white truncate">
                          {anom.participant.name}{' '}
                          <span className="font-mono text-[10px] font-normal text-stone-400">
                            [ID: {anom.participant.identity_id || `P-${anom.participant.sl_no}`}]
                          </span>
                        </span>
                        <span className="text-xs font-mono font-black text-orange-600 dark:text-orange-400">
                          Δ {anom.delta.toFixed(1)} pts Discrepancy
                        </span>
                      </div>

                      <p className="text-[11px] text-stone-500 dark:text-zinc-400">
                        {anom.event.name}
                      </p>

                      <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                        <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                          <span className="text-[10px] text-emerald-700 dark:text-emerald-400 uppercase font-bold block">
                            High Ballot
                          </span>
                          <span className="font-bold text-stone-900 dark:text-white">
                            {anom.highJudge.name}
                          </span>
                          <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400 float-right">
                            {anom.highScore} pts
                          </span>
                        </div>

                        <div className="p-2 rounded-lg bg-rose-500/10 border border-rose-500/20">
                          <span className="text-[10px] text-rose-700 dark:text-rose-400 uppercase font-bold block">
                            Low Ballot
                          </span>
                          <span className="font-bold text-stone-900 dark:text-white">
                            {anom.lowJudge.name}
                          </span>
                          <span className="font-mono font-bold text-rose-600 dark:text-rose-400 float-right">
                            {anom.lowScore} pts
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* SECTION D: LOGS (The Cryptographic Ledger)               */}
        {/* ======================================================== */}
        {activePillar === 'logs' && (
          <div className="space-y-4 animate-in fade-in duration-200">
            {/* Header: Two massive export buttons */}
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={handleExportLogsPDF}
                className="min-h-[44px] px-3 bg-stone-900 hover:bg-stone-800 dark:bg-zinc-100 dark:hover:bg-white text-white dark:text-zinc-900 font-bold text-xs rounded-xl shadow-sm active:scale-95 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <Printer className="w-4 h-4 stroke-[2.2] text-stone-400 dark:text-stone-600" />
                <span>Export PDF (Logs)</span>
              </button>

              <button
                type="button"
                onClick={handleExportLogsExcel}
                className="min-h-[44px] px-3 bg-stone-700 hover:bg-stone-600 text-white font-bold text-xs rounded-xl shadow-sm active:scale-95 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <FileSpreadsheet className="w-4 h-4 stroke-[2.2]" />
                <span>Download Excel (Logs)</span>
              </button>
            </div>

            {/* Filter Controls Strip */}
            <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800/80 rounded-2xl p-3 shadow-xs space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* Event Filter Dropdown */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      setIsEventDropdownOpen((prev) => !prev);
                      setIsJudgeDropdownOpen(false);
                    }}
                    className="min-h-[36px] px-3 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-xs font-semibold text-stone-800 dark:text-zinc-200 flex items-center gap-2 cursor-pointer"
                  >
                    <Trophy className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    <span className="truncate max-w-[130px]">
                      {selectedEventFilter === 'all'
                        ? 'All Events'
                        : eventMap.get(selectedEventFilter)?.name || 'Event'}
                    </span>
                    <ChevronDown className="w-3.5 h-3.5 text-stone-400" />
                  </button>

                  {isEventDropdownOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setIsEventDropdownOpen(false)} />
                      <div className="absolute left-0 mt-1.5 w-56 rounded-xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 shadow-xl py-1.5 z-30 max-h-56 overflow-y-auto">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedEventFilter('all');
                            setIsEventDropdownOpen(false);
                          }}
                          className="w-full px-3 py-2 text-left text-xs font-medium flex items-center justify-between hover:bg-stone-100 dark:hover:bg-zinc-900 cursor-pointer"
                        >
                          <span>All Events</span>
                          {selectedEventFilter === 'all' && <Check className="w-3.5 h-3.5 text-emerald-500" />}
                        </button>
                        {events.map((e) => (
                          <button
                            key={e.id}
                            type="button"
                            onClick={() => {
                              setSelectedEventFilter(e.id);
                              setIsEventDropdownOpen(false);
                            }}
                            className="w-full px-3 py-2 text-left text-xs font-medium flex items-center justify-between hover:bg-stone-100 dark:hover:bg-zinc-900 cursor-pointer"
                          >
                            <span className="truncate pr-2">{e.name}</span>
                            {selectedEventFilter === e.id && <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {/* Judge Filter Dropdown */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      setIsJudgeDropdownOpen((prev) => !prev);
                      setIsEventDropdownOpen(false);
                    }}
                    className="min-h-[36px] px-3 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-xs font-semibold text-stone-800 dark:text-zinc-200 flex items-center gap-2 cursor-pointer"
                  >
                    <Gavel className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                    <span className="truncate max-w-[130px]">
                      {selectedJudgeFilter === 'all'
                        ? 'All Judges'
                        : judgeMap.get(selectedJudgeFilter)?.name || 'Judge'}
                    </span>
                    <ChevronDown className="w-3.5 h-3.5 text-stone-400" />
                  </button>

                  {isJudgeDropdownOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setIsJudgeDropdownOpen(false)} />
                      <div className="absolute right-0 mt-1.5 w-56 rounded-xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 shadow-xl py-1.5 z-30 max-h-56 overflow-y-auto">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedJudgeFilter('all');
                            setIsJudgeDropdownOpen(false);
                          }}
                          className="w-full px-3 py-2 text-left text-xs font-medium flex items-center justify-between hover:bg-stone-100 dark:hover:bg-zinc-900 cursor-pointer"
                        >
                          <span>All Judges</span>
                          {selectedJudgeFilter === 'all' && <Check className="w-3.5 h-3.5 text-emerald-500" />}
                        </button>
                        {judges.map((j) => (
                          <button
                            key={j.id}
                            type="button"
                            onClick={() => {
                              setSelectedJudgeFilter(j.id);
                              setIsJudgeDropdownOpen(false);
                            }}
                            className="w-full px-3 py-2 text-left text-xs font-medium flex items-center justify-between hover:bg-stone-100 dark:hover:bg-zinc-900 cursor-pointer"
                          >
                            <span className="truncate pr-2">{j.name}</span>
                            {selectedJudgeFilter === j.id && <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Compact Search Bar */}
              <div className="relative w-full">
                <Search className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchAudit}
                  onChange={(e) => setSearchAudit(e.target.value)}
                  placeholder="Filter timeline by competitor, judge, or event..."
                  className="w-full min-h-[38px] pl-8 pr-8 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-xs font-medium text-stone-900 dark:text-white placeholder:text-stone-400 focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
                />
                {searchAudit && (
                  <button
                    type="button"
                    onClick={() => setSearchAudit('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Retained Rod & Dot Timeline UI */}
            {filteredScores.length === 0 ? (
              <div className="text-xs text-stone-500 py-6 text-center bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800">
                No cryptographic ballot commits match your current filters.
              </div>
            ) : (
              <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800/80 rounded-2xl p-4 sm:p-5 shadow-xs">
                <div className="border-l-2 border-stone-200 dark:border-zinc-800 ml-2.5 pl-4 space-y-5 pt-1">
                  {filteredScores.slice(0, 50).map((score) => {
                    const p = participantMap.get(score.participant_id);
                    const j = judgeMap.get(score.judge_id);
                    const e = eventMap.get(score.event_id);
                    const breakdown = score.score_payload?.criteria || score.score_data || {};
                    const time = new Date(score.created_at).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    });

                    return (
                      <div key={score.id} className="relative group">
                        {/* Dot on rod */}
                        <div className="absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full bg-stone-300 dark:bg-zinc-700 group-hover:bg-emerald-500 border-2 border-white dark:border-zinc-950 transition-colors" />

                        <div className="text-[11px] text-stone-400 dark:text-zinc-500 font-mono flex flex-wrap items-center gap-2 mb-1">
                          <span className="flex items-center gap-1 text-stone-500 dark:text-zinc-400">
                            <Clock className="w-3 h-3 text-stone-400" />
                            {time}
                          </span>
                          <span>•</span>
                          <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold">
                            #{score.id.slice(0, 6).toUpperCase()}
                          </span>
                          {e && (
                            <>
                              <span>•</span>
                              <span className="text-stone-600 dark:text-zinc-400 truncate max-w-[180px]">
                                {e.name}
                              </span>
                            </>
                          )}
                        </div>

                        <div className="text-xs text-stone-700 dark:text-zinc-300 leading-relaxed">
                          <strong className="text-stone-900 dark:text-white font-semibold">
                            {j?.name || 'Judge'}
                          </strong>{' '}
                          securely committed{' '}
                          <strong className="text-emerald-600 dark:text-emerald-400 font-mono font-bold">
                            {score.total_score} pts
                          </strong>{' '}
                          for{' '}
                          <strong className="text-stone-900 dark:text-white font-semibold">
                            {p?.name || 'Participant'}
                          </strong>
                          {p?.identity_id && (
                            <span className="ml-1.5 font-mono text-[10px] px-1.5 py-0.5 rounded bg-stone-100 dark:bg-zinc-900 text-stone-600 dark:text-zinc-400 border border-stone-200 dark:border-zinc-800">
                              [ID: {p.identity_id}]
                            </span>
                          )}
                        </div>

                        {Object.keys(breakdown).length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {Object.entries(breakdown).map(([critId, mark]) => (
                              <span
                                key={critId}
                                className="px-2 py-0.5 rounded-md bg-stone-50 dark:bg-zinc-900 border border-stone-200/80 dark:border-zinc-800/80 text-[10px] font-mono text-stone-600 dark:text-zinc-400"
                              >
                                {critId.replace('crit_', '').replace(/_/g, ' ')}:{' '}
                                <strong className="text-stone-900 dark:text-white">{String(mark)}</strong>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
