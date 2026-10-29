import React, { useState, useEffect, useMemo } from 'react';
import { 
  Activity, 
  Database, 
  Users, 
  AlertTriangle, 
  FileSpreadsheet, 
  FileText, 
  Download, 
  X,
  Trophy,
  ShieldCheck,
  Search,
  Clock,
  ChevronDown,
  Check,
  CalendarDays,
  Gavel
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { 
  Organization, 
  SupabaseEvent, 
  SupabaseJudge, 
  SupabaseParticipant, 
  SupabaseScore 
} from '../../../lib/supabaseTypes';
import { dbService, subscribeToDatabase } from '../../../lib/supabase';
import { PullToRefresh } from '../../common/PullToRefresh';

interface InsightsTabProps {
  organization: Organization;
}

interface ParticipantStanding {
  participant: SupabaseParticipant;
  ballotCount: number;
  rawTotal: number;
  averageScore: number;
}

export function InsightsTab({ organization }: InsightsTabProps) {
  // --- STATE ---
  const [events, setEvents] = useState<SupabaseEvent[]>([]);
  const [judges, setJudges] = useState<SupabaseJudge[]>([]);
  const [participants, setParticipants] = useState<SupabaseParticipant[]>([]);
  const [allScores, setAllScores] = useState<SupabaseScore[]>([]);
  const [isPdfModalOpen, setIsPdfModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Cryptographic System Log Filters & Custom Dropdown States
  const [selectedEventFilter, setSelectedEventFilter] = useState<string>('all');
  const [selectedJudgeFilter, setSelectedJudgeFilter] = useState<string>('all');
  const [searchAudit, setSearchAudit] = useState<string>('');
  const [isEventDropdownOpen, setIsEventDropdownOpen] = useState(false);
  const [isJudgeDropdownOpen, setIsJudgeDropdownOpen] = useState(false);

  // --- DATA FETCHING (Live Supabase) ---
  const loadData = async () => {
    try {
      const [eList, jList, pList] = await Promise.all([
        dbService.getEvents(organization.org_id),
        dbService.getJudges(organization.org_id),
        dbService.getParticipants(organization.org_id),
      ]);
      setEvents(eList);
      setJudges(jList);
      setParticipants(pList);

      const scorePromises = eList.map((e) => dbService.getScores(e.id));
      const scoreResults = await Promise.all(scorePromises);
      setAllScores(scoreResults.flat());
    } catch (err) {
      console.error('Failed to load insights data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const unsub = subscribeToDatabase(() => {
      loadData();
    });
    return () => unsub();
  }, [organization.org_id]);

  // --- LOOKUP MAPS ---
  const eventMap = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const judgeMap = useMemo(() => new Map(judges.map((j) => [j.id, j])), [judges]);
  const participantMap = useMemo(() => new Map(participants.map((p) => [p.id, p])), [participants]);

  // --- DERIVED EVENT STANDINGS ---
  const eventStandings = useMemo(() => {
    return events.map((ev) => {
      const evScores = allScores.filter((s) => s.event_id === ev.id);
      const byParticipant = new Map<string, SupabaseScore[]>();

      evScores.forEach((s) => {
        const list = byParticipant.get(s.participant_id) || [];
        list.push(s);
        byParticipant.set(s.participant_id, list);
      });

      const standings: ParticipantStanding[] = Array.from(byParticipant.entries())
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
        .filter((item): item is ParticipantStanding => item !== null)
        .sort((a, b) => b.averageScore - a.averageScore || b.rawTotal - a.rawTotal);

      return {
        event: ev,
        standings,
      };
    });
  }, [events, allScores, participantMap]);

  // --- SECTION 1: OPERATIONAL TELEMETRY ---
  const eventsCompleted = events.filter((e) => e.status === 'ended').length;

  const pendingPerformances = useMemo(() => {
    const activeOrUpcoming = events.filter((e) => e.status === 'active' || e.status === 'upcoming');
    let remaining = 0;

    activeOrUpcoming.forEach((ev) => {
      const assignedPIds: string[] = (ev as any).assigned_participants || [];
      const assignedJIds: string[] = (ev as any).assigned_judges || [];
      const expectedJudgesCount = assignedJIds.length || 1;

      if (assignedPIds.length > 0) {
        assignedPIds.forEach((pId) => {
          const submittedBallots = allScores.filter(
            (s) => s.event_id === ev.id && s.participant_id === pId
          ).length;
          if (submittedBallots < expectedJudgesCount) {
            remaining += 1;
          }
        });
      }
    });

    return remaining;
  }, [events, allScores]);

  // --- SECTION 2: INSTITUTIONAL LEADERBOARD ---
  const institutionalStandings = useMemo(() => {
    const schoolMap = new Map<
      string,
      { gold: number; silver: number; bronze: number; totalPoints: number }
    >();

    eventStandings.forEach(({ standings }) => {
      standings.slice(0, 3).forEach((row, idx) => {
        const school =
          (row.participant as any).school ||
          (row.participant as any).institution ||
          'Independent';
        const cur = schoolMap.get(school) || { gold: 0, silver: 0, bronze: 0, totalPoints: 0 };
        if (idx === 0) cur.gold += 1;
        if (idx === 1) cur.silver += 1;
        if (idx === 2) cur.bronze += 1;
        schoolMap.set(school, cur);
      });
    });

    allScores.forEach((s) => {
      const p = participantMap.get(s.participant_id);
      if (!p) return;
      const school = (p as any).school || (p as any).institution || 'Independent';
      const cur = schoolMap.get(school) || { gold: 0, silver: 0, bronze: 0, totalPoints: 0 };
      cur.totalPoints += s.total_score || 0;
      schoolMap.set(school, cur);
    });

    return Array.from(schoolMap.entries())
      .sort(
        (a, b) =>
          b[1].gold - a[1].gold ||
          b[1].silver - a[1].silver ||
          b[1].totalPoints - a[1].totalPoints
      )
      .slice(0, 6);
  }, [eventStandings, allScores, participantMap]);

  // --- SECTION 3: JURY INTEGRITY & BIAS ENGINE ---
  const globalMean = useMemo(() => {
    if (allScores.length === 0) return 0;
    return allScores.reduce((sum, s) => sum + (s.total_score || 0), 0) / allScores.length;
  }, [allScores]);

  const judgeBiases = useMemo(() => {
    if (globalMean === 0) return [];
    return judges
      .map((j) => {
        const jScores = allScores.filter((s) => s.judge_id === j.id);
        if (jScores.length < 2) return null;
        const jMean = jScores.reduce((sum, s) => sum + (s.total_score || 0), 0) / jScores.length;
        const variancePct = ((jMean - globalMean) / globalMean) * 100;
        return { judge: j, variancePct, mean: jMean, count: jScores.length };
      })
      .filter(
        (item): item is { judge: SupabaseJudge; variancePct: number; mean: number; count: number } =>
          item !== null && Math.abs(item.variancePct) >= 15
      );
  }, [judges, allScores, globalMean]);

  const consensusAnomalies = useMemo(() => {
    const flags: Array<{
      id: string;
      participantName: string;
      judgeName: string;
      eventName: string;
      judgeScore: number;
      consensusMedian: number;
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
      const sortedVals = scores.map((s) => s.total_score || 0).sort((a, b) => a - b);
      const mid = Math.floor(sortedVals.length / 2);
      const median =
        sortedVals.length % 2 !== 0
          ? sortedVals[mid]
          : (sortedVals[mid - 1] + sortedVals[mid]) / 2;

      if (median === 0) return;

      scores.forEach((s) => {
        const deviation = Math.abs((s.total_score || 0) - median) / median;
        if (deviation >= 0.35) {
          const p = participantMap.get(s.participant_id);
          const j = judgeMap.get(s.judge_id);
          const e = eventMap.get(s.event_id);
          flags.push({
            id: s.id,
            participantName: p?.name || 'Participant',
            judgeName: j?.name || 'Judge',
            eventName: e?.name || 'Competition',
            judgeScore: s.total_score || 0,
            consensusMedian: Number(median.toFixed(1)),
          });
        }
      });
    });

    return flags;
  }, [allScores, participantMap, judgeMap, eventMap]);

  const activeAnomaliesCount = judgeBiases.length + consensusAnomalies.length;

  // --- SECTION 5: FILTERED CRYPTOGRAPHIC LOG ---
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

  // --- SECTION 4: EXPORT HANDLERS ---
  const handleExportMasterSummary = () => {
    const rows = filteredScores.map((s, idx) => {
      const p = participantMap.get(s.participant_id);
      const j = judgeMap.get(s.judge_id);
      const e = eventMap.get(s.event_id);
      return {
        '#': idx + 1,
        Timestamp: new Date(s.created_at).toLocaleString(),
        Event: e?.name || s.event_id,
        Category: (e as any)?.category || 'General',
        'Participant Serial': p?.sl_no || '—',
        'Participant Name': p?.name || s.participant_id,
        Institution: (p as any)?.school || (p as any)?.institution || '—',
        'Judge Name': j?.name || s.judge_id,
        'Total Score': s.total_score,
        'Score Breakdown': JSON.stringify(s.score_payload?.criteria || s.score_data || {}),
        'Ledger Entry ID': s.id,
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Audit_Ledger');
    XLSX.writeFile(wb, `fairjudge_master_summary_${organization.org_id}.xlsx`);
  };

  const handleExportJuryAnalytics = () => {
    const rows = judges.map((j) => {
      const jScores = allScores.filter((s) => s.judge_id === j.id);
      const jMean =
        jScores.length > 0
          ? jScores.reduce((sum, s) => sum + (s.total_score || 0), 0) / jScores.length
          : 0;
      const variance =
        globalMean > 0 && jScores.length > 0 ? ((jMean - globalMean) / globalMean) * 100 : 0;

      return {
        'Judge ID': j.judge_id || j.id.slice(0, 6),
        'Judge Name': j.name,
        'Ballots Submitted': jScores.length,
        'Judge Mean Score': jMean.toFixed(2),
        'Global Jury Mean': globalMean.toFixed(2),
        'Bias Deviation (%)': `${variance > 0 ? '+' : ''}${variance.toFixed(1)}%`,
        Status:
          Math.abs(variance) >= 15
            ? variance > 0
              ? 'LENIENT BIAS FLAG'
              : 'STRICT BIAS FLAG'
            : 'NORMALIZED',
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const csvOutput = XLSX.utils.sheet_to_csv(ws);
    const blob = new Blob([csvOutput], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `fairjudge_jury_analytics_${organization.org_id}.csv`;
    link.click();
  };

  // --- STANDALONE NEW-PAGE HTML GENERATOR & PRINT ENGINE ---
  const executePDFExport = (mode: 'top3' | 'full') => {
    setIsPdfModalOpen(false);

    const escapeHtml = (str: string) =>
      String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const reportTitle =
      mode === 'top3'
        ? 'OFFICIAL PRESS RELEASE — TOP 3 PODIUM WINNERS'
        : 'OFFICIAL MASTER SCORE REPORT — FULL CATEGORY ROSTER';

    const sectionsHtml = eventStandings
      .map(({ event, standings }) => {
        const rowsToDisplay = mode === 'top3' ? standings.slice(0, 3) : standings;
        if (rowsToDisplay.length === 0) return '';

        const categoryLabel = (event as any).category
          ? `${escapeHtml((event as any).category)} — `
          : '';

        const rowsHtml = rowsToDisplay
          .map((row, idx) => {
            const rankLabel =
              idx === 0 ? '1st 🥇' : idx === 1 ? '2nd 🥈' : idx === 2 ? '3rd 🥉' : `#${idx + 1}`;
            const school =
              (row.participant as any).school ||
              (row.participant as any).institution ||
              '—';

            return `
              <tr>
                <td class="rank">${rankLabel}</td>
                <td class="serial">${escapeHtml(String(row.participant.sl_no || '—'))}</td>
                <td class="name">${escapeHtml(row.participant.name)}</td>
                <td class="school">${escapeHtml(school)}</td>
                <td class="num">${row.ballotCount}</td>
                <td class="score">${row.averageScore.toFixed(2)} pts</td>
              </tr>
            `;
          })
          .join('');

        return `
          <div class="event-block">
            <div class="event-header">
              <h2>${categoryLabel}${escapeHtml(event.name)}</h2>
              <span class="badge">STATUS: ${escapeHtml(event.status.toUpperCase())}</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th style="width: 75px;">Rank</th>
                  <th style="width: 70px;">Sl. No</th>
                  <th>Participant Name</th>
                  <th>School / Institution</th>
                  <th style="width: 80px; text-align: right;">Ballots</th>
                  <th style="width: 110px; text-align: right;">Final Score</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          </div>
        `;
      })
      .filter(Boolean)
      .join('');

    const htmlDocument = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(organization.name)} - ${reportTitle}</title>
        <style>
          @page { size: A4 portrait; margin: 16mm; }
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background: #ffffff !important;
            color: #111827 !important;
            padding: 24px;
            line-height: 1.45;
          }
          .doc-header {
            border-bottom: 2px solid #111827;
            padding-bottom: 14px;
            margin-bottom: 24px;
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
          }
          .brand {
            font-size: 11px;
            font-weight: 800;
            letter-spacing: 0.12em;
            color: #059669;
            text-transform: uppercase;
            margin-bottom: 4px;
          }
          .org-title {
            font-size: 22px;
            font-weight: 900;
            letter-spacing: -0.02em;
            color: #111827;
          }
          .report-sub {
            font-size: 11px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            color: #4b5563;
            margin-top: 4px;
          }
          .meta {
            text-align: right;
            font-size: 11px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            color: #4b5563;
          }
          .event-block {
            margin-bottom: 28px;
            page-break-inside: avoid;
          }
          .event-header {
            background: #f3f4f6;
            border: 1px solid #d1d5db;
            border-bottom: none;
            padding: 8px 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .event-header h2 {
            font-size: 13px;
            font-weight: 800;
            text-transform: uppercase;
            color: #111827;
          }
          .badge {
            font-size: 10px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-weight: 700;
            color: #374151;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
            border: 1px solid #d1d5db;
          }
          th {
            background: #f9fafb;
            border-bottom: 1.5px solid #111827;
            padding: 8px 10px;
            text-align: left;
            font-size: 10px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            color: #374151;
          }
          td {
            padding: 8px 10px;
            border-bottom: 1px solid #e5e7eb;
            color: #111827;
          }
          td.rank {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-weight: 800;
          }
          td.serial {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            color: #6b7280;
          }
          td.name {
            font-weight: 700;
          }
          td.school {
            color: #4b5563;
          }
          td.num {
            text-align: right;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          }
          td.score {
            text-align: right;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-weight: 800;
            color: #059669;
          }
          .empty-box {
            padding: 36px;
            border: 1px dashed #d1d5db;
            text-align: center;
            color: #6b7280;
            font-size: 13px;
          }
          .doc-footer {
            margin-top: 32px;
            padding-top: 12px;
            border-top: 1px solid #d1d5db;
            display: flex;
            justify-content: space-between;
            font-size: 10px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            color: #6b7280;
          }
        </style>
      </head>
      <body>
        <div class="doc-header">
          <div>
            <div class="brand">Fair Judge • Official Cryptographic Ledger</div>
            <div class="org-title">${escapeHtml(organization.name)}</div>
            <div class="report-sub">${reportTitle}</div>
          </div>
          <div class="meta">
            <div>ORG ID: ${escapeHtml(organization.org_id)}</div>
            <div>GENERATED: ${new Date().toLocaleString()}</div>
          </div>
        </div>

        ${
          sectionsHtml ||
          '<div class="empty-box">No scored performances recorded yet to generate standings.</div>'
        }

        <div class="doc-footer">
          <span>Verified by Fair Judge Immutable Scoring Engine</span>
          <span>Official Record</span>
        </div>

        <script>
          window.onload = function() {
            setTimeout(function() {
              window.focus();
              window.print();
            }, 250);
          };
        </script>
      </body>
      </html>
    `;

    const printWin = window.open('', '_blank');
    if (printWin) {
      printWin.document.open();
      printWin.document.write(htmlDocument);
      printWin.document.close();
    } else {
      const iframe = document.createElement('iframe');
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';
      document.body.appendChild(iframe);

      const doc = iframe.contentWindow?.document;
      if (doc) {
        doc.open();
        doc.write(htmlDocument);
        doc.close();
        setTimeout(() => {
          iframe.contentWindow?.focus();
          iframe.contentWindow?.print();
          setTimeout(() => document.body.removeChild(iframe), 2000);
        }, 300);
      }
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs font-mono text-zinc-500">
        Syncing Cryptographic Telemetry...
      </div>
    );
  }

  return (
    <PullToRefresh
      onRefresh={loadData}
      className="flex-1 overflow-y-auto px-4 py-4 space-y-6 pb-40 select-none animate-in fade-in duration-200 bg-stone-50 dark:bg-black"
    >
      {/* Header */}
      <div className="pt-1">
        <h2 className="text-2xl font-black text-zinc-900 dark:text-white tracking-tight">
          Audit &amp; Insights
        </h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 font-mono mt-0.5">
          Immutable scoring telemetry, bias verification &amp; official exports
        </p>
      </div>

      {/* SECTION 1: OPERATIONAL TELEMETRY (2x2 Grid) */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 shadow-sm">
          <div className="flex items-center space-x-2 text-zinc-500 dark:text-zinc-400 mb-2">
            <Activity className="w-4 h-4 text-emerald-500" />
            <span className="text-[10px] font-bold uppercase tracking-wider">Event Burndown</span>
          </div>
          <div className="flex items-baseline space-x-1.5">
            <span className="text-2xl font-black text-zinc-900 dark:text-white font-mono">
              {eventsCompleted} / {events.length}
            </span>
            <span className="text-[11px] text-zinc-400 font-medium">Completed</span>
          </div>
        </div>

        <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 shadow-sm">
          <div className="flex items-center space-x-2 text-zinc-500 dark:text-zinc-400 mb-2">
            <Database className="w-4 h-4 text-blue-500" />
            <span className="text-[10px] font-bold uppercase tracking-wider">Ledger Volume</span>
          </div>
          <div className="flex items-baseline space-x-1.5">
            <span className="text-2xl font-black text-zinc-900 dark:text-white font-mono">
              {allScores.length}
            </span>
            <span className="text-[11px] text-emerald-500 font-semibold">Processed</span>
          </div>
        </div>

        <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 shadow-sm">
          <div className="flex items-center space-x-2 text-zinc-500 dark:text-zinc-400 mb-2">
            <Users className="w-4 h-4 text-amber-500" />
            <span className="text-[10px] font-bold uppercase tracking-wider">Pending Performances</span>
          </div>
          <div className="flex items-baseline space-x-1.5">
            <span className="text-2xl font-black text-zinc-900 dark:text-white font-mono">
              {pendingPerformances}
            </span>
            <span className="text-[11px] text-amber-500 font-semibold">Left</span>
          </div>
        </div>

        <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 shadow-sm">
          <div className="flex items-center space-x-2 text-zinc-500 dark:text-zinc-400 mb-2">
            <AlertTriangle
              className={`w-4 h-4 ${activeAnomaliesCount > 0 ? 'text-red-500' : 'text-zinc-400'}`}
            />
            <span className="text-[10px] font-bold uppercase tracking-wider">Active Anomalies</span>
          </div>
          <div className="flex items-baseline space-x-1.5">
            <span className="text-2xl font-black text-zinc-900 dark:text-white font-mono">
              {activeAnomaliesCount}
            </span>
            <span
              className={`text-[11px] font-semibold ${
                activeAnomaliesCount > 0 ? 'text-red-500' : 'text-zinc-400'
              }`}
            >
              Flags
            </span>
          </div>
        </div>
      </div>

      {/* SECTION 2: INSTITUTIONAL LEADERBOARD */}
      <div className="space-y-2.5">
        <h3 className="text-xs font-bold uppercase text-zinc-500 tracking-wider">
          Global Institution Standings
        </h3>
        <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl shadow-sm overflow-hidden">
          {institutionalStandings.length === 0 ? (
            <div className="p-5 text-xs text-zinc-500 text-center">
              No institutional points recorded yet.
            </div>
          ) : (
            <div className="divide-y divide-stone-100 dark:divide-zinc-800/70">
              {institutionalStandings.map(([school, stats], idx) => (
                <div key={school} className="p-3.5 flex items-center justify-between gap-3">
                  <div className="flex items-center space-x-3 min-w-0">
                    <span className="font-mono text-xs font-bold text-zinc-400 w-4">
                      {idx + 1}.
                    </span>
                    <span className="text-sm font-bold text-zinc-900 dark:text-white truncate">
                      {school}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2 shrink-0 text-xs font-mono">
                    {stats.gold > 0 && (
                      <span className="px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 font-bold">
                        {stats.gold} Gold
                      </span>
                    )}
                    {stats.silver > 0 && (
                      <span className="px-2 py-0.5 rounded-md bg-zinc-500/10 text-zinc-600 dark:text-zinc-300 font-bold">
                        {stats.silver} Silver
                      </span>
                    )}
                    <span className="text-emerald-600 dark:text-emerald-400 font-black pl-1">
                      {stats.totalPoints.toFixed(0)} pts
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* SECTION 3: JURY INTEGRITY & BIAS WARNINGS */}
      <div className="space-y-2.5">
        <h3 className="text-xs font-bold uppercase text-zinc-500 tracking-wider">
          Jury Analytics &amp; Anomalies
        </h3>
        <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl shadow-sm p-4 space-y-2.5">
          {activeAnomaliesCount === 0 ? (
            <div className="flex items-center space-x-2.5 text-emerald-600 dark:text-emerald-400 text-xs font-medium py-1">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>Jury consensus is within normal parameters. Zero bias or variance flags.</span>
            </div>
          ) : (
            <>
              {judgeBiases.map((b) => (
                <div
                  key={b.judge.id}
                  className="p-3 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 text-amber-800 dark:text-amber-300 text-xs leading-relaxed flex items-start gap-2.5"
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                  <div>
                    <strong>{b.judge.name}</strong> is scoring{' '}
                    <strong>{Math.abs(b.variancePct).toFixed(0)}%</strong>{' '}
                    {b.variancePct < 0 ? 'stricter' : 'higher'} than the jury median across{' '}
                    {b.count} ballots.
                  </div>
                </div>
              ))}

              {consensusAnomalies.slice(0, 5).map((flag) => (
                <div
                  key={flag.id}
                  className="p-3 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-800 dark:text-red-300 text-xs leading-relaxed flex items-start gap-2.5"
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
                  <div>
                    <strong>{flag.participantName}</strong> ({flag.eventName}):{' '}
                    <strong>{flag.judgeName}</strong> scored{' '}
                    <span className="font-mono font-bold">{flag.judgeScore}</span> while jury
                    consensus was <span className="font-mono font-bold">{flag.consensusMedian}</span>.
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* SECTION 4: THE EXPORT TERMINAL */}
      <div className="space-y-2.5">
        <h3 className="text-xs font-bold uppercase text-zinc-500 tracking-wider">
          Export Terminal
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          <button
            type="button"
            onClick={handleExportMasterSummary}
            className="min-h-[48px] px-4 rounded-xl font-bold text-xs transition-all active:scale-[0.98] flex items-center justify-center gap-2 bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 hover:border-emerald-500/40 dark:hover:border-emerald-500/40 hover:bg-stone-100 dark:hover:bg-zinc-900 text-zinc-800 dark:text-zinc-200 shadow-sm cursor-pointer"
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-500 shrink-0" />
            <span>Download Master Summary (.xlsx)</span>
          </button>

          <button
            type="button"
            onClick={handleExportJuryAnalytics}
            className="min-h-[48px] px-4 rounded-xl font-bold text-xs transition-all active:scale-[0.98] flex items-center justify-center gap-2 bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 hover:border-blue-500/40 dark:hover:border-blue-500/40 hover:bg-stone-100 dark:hover:bg-zinc-900 text-zinc-800 dark:text-zinc-200 shadow-sm cursor-pointer"
          >
            <FileText className="w-4 h-4 text-blue-500 shrink-0" />
            <span>Export Jury Analytics (.csv)</span>
          </button>

          <button
            type="button"
            onClick={() => setIsPdfModalOpen(true)}
            className="min-h-[48px] px-4 rounded-xl font-bold text-xs transition-all active:scale-[0.98] flex items-center justify-center gap-2 bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30 shadow-sm cursor-pointer"
          >
            <Download className="w-4 h-4 text-emerald-500 shrink-0" />
            <span>Press Release / Results (.pdf)</span>
          </button>
        </div>
      </div>

      {/* SECTION 5: CRYPTOGRAPHIC SYSTEM LOG (Borderless Rod & Dot Timeline) */}
      <div className="space-y-4 pt-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center space-x-2">
            <ShieldCheck className="w-4 h-4 text-emerald-500" />
            <h3 className="text-xs font-bold uppercase text-zinc-500 tracking-wider">
              Cryptographic System Log
            </h3>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-stone-200/70 dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400">
              {filteredScores.length} entries
            </span>
          </div>

          {/* Custom Framer-Grade Popover Dropdowns */}
          <div className="flex flex-wrap items-center gap-2 relative z-20">
            {/* Event Filter Dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setIsEventDropdownOpen((prev) => !prev);
                  setIsJudgeDropdownOpen(false);
                }}
                className="min-h-[36px] px-3 rounded-xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 hover:border-stone-300 dark:hover:border-zinc-700 text-xs font-medium text-zinc-800 dark:text-zinc-200 flex items-center gap-2 shadow-sm transition-all active:scale-[0.98] cursor-pointer"
              >
                <CalendarDays className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                <span className="truncate max-w-[130px]">
                  {selectedEventFilter === 'all'
                    ? 'All Events'
                    : eventMap.get(selectedEventFilter)?.name || 'Event'}
                </span>
                <ChevronDown
                  className={`w-3.5 h-3.5 text-zinc-400 transition-transform duration-200 ${
                    isEventDropdownOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {isEventDropdownOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setIsEventDropdownOpen(false)}
                  />
                  <div className="absolute right-0 mt-1.5 w-56 rounded-2xl bg-white/95 dark:bg-zinc-950/95 backdrop-blur-xl border border-stone-200 dark:border-zinc-800 shadow-xl py-1.5 z-30 max-h-60 overflow-y-auto animate-in fade-in zoom-in-95 duration-150">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedEventFilter('all');
                        setIsEventDropdownOpen(false);
                      }}
                      className="w-full px-3 py-2 text-left text-xs font-medium flex items-center justify-between hover:bg-stone-100 dark:hover:bg-zinc-900 text-zinc-800 dark:text-zinc-200 cursor-pointer"
                    >
                      <span>All Events</span>
                      {selectedEventFilter === 'all' && (
                        <Check className="w-3.5 h-3.5 text-emerald-500" />
                      )}
                    </button>
                    {events.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => {
                          setSelectedEventFilter(e.id);
                          setIsEventDropdownOpen(false);
                        }}
                        className="w-full px-3 py-2 text-left text-xs font-medium flex items-center justify-between hover:bg-stone-100 dark:hover:bg-zinc-900 text-zinc-800 dark:text-zinc-200 cursor-pointer"
                      >
                        <span className="truncate pr-2">{e.name}</span>
                        {selectedEventFilter === e.id && (
                          <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                        )}
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
                className="min-h-[36px] px-3 rounded-xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 hover:border-stone-300 dark:hover:border-zinc-700 text-xs font-medium text-zinc-800 dark:text-zinc-200 flex items-center gap-2 shadow-sm transition-all active:scale-[0.98] cursor-pointer"
              >
                <Gavel className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                <span className="truncate max-w-[130px]">
                  {selectedJudgeFilter === 'all'
                    ? 'All Judges'
                    : judgeMap.get(selectedJudgeFilter)?.name || 'Judge'}
                </span>
                <ChevronDown
                  className={`w-3.5 h-3.5 text-zinc-400 transition-transform duration-200 ${
                    isJudgeDropdownOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {isJudgeDropdownOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setIsJudgeDropdownOpen(false)}
                  />
                  <div className="absolute right-0 mt-1.5 w-56 rounded-2xl bg-white/95 dark:bg-zinc-950/95 backdrop-blur-xl border border-stone-200 dark:border-zinc-800 shadow-xl py-1.5 z-30 max-h-60 overflow-y-auto animate-in fade-in zoom-in-95 duration-150">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedJudgeFilter('all');
                        setIsJudgeDropdownOpen(false);
                      }}
                      className="w-full px-3 py-2 text-left text-xs font-medium flex items-center justify-between hover:bg-stone-100 dark:hover:bg-zinc-900 text-zinc-800 dark:text-zinc-200 cursor-pointer"
                    >
                      <span>All Judges</span>
                      {selectedJudgeFilter === 'all' && (
                        <Check className="w-3.5 h-3.5 text-emerald-500" />
                      )}
                    </button>
                    {judges.map((j) => (
                      <button
                        key={j.id}
                        type="button"
                        onClick={() => {
                          setSelectedJudgeFilter(j.id);
                          setIsJudgeDropdownOpen(false);
                        }}
                        className="w-full px-3 py-2 text-left text-xs font-medium flex items-center justify-between hover:bg-stone-100 dark:hover:bg-zinc-900 text-zinc-800 dark:text-zinc-200 cursor-pointer"
                      >
                        <span className="truncate pr-2">{j.name}</span>
                        {selectedJudgeFilter === j.id && (
                          <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Compact Search Bar */}
        <div className="relative w-full">
          <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchAudit}
            onChange={(e) => setSearchAudit(e.target.value)}
            placeholder="Filter cryptographic timeline by competitor, judge, or event..."
            className="w-full min-h-[38px] pl-9 pr-8 rounded-xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 text-xs font-medium text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 transition-all"
          />
          {searchAudit && (
            <button
              type="button"
              onClick={() => setSearchAudit('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Borderless Rod & Dot Timeline */}
        {filteredScores.length === 0 ? (
          <div className="text-xs text-zinc-500 py-4 pl-1">
            No cryptographic events match your current filters.
          </div>
        ) : (
          <div className="border-l-2 border-stone-200 dark:border-zinc-800 ml-3 pl-4 space-y-5 pt-1">
            {filteredScores.slice(0, 40).map((score) => {
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
                  <div className="absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full bg-stone-300 dark:bg-zinc-700 group-hover:bg-emerald-500 border-2 border-stone-50 dark:border-black transition-colors" />

                  <div className="text-[11px] text-zinc-500 font-mono flex flex-wrap items-center gap-2 mb-1">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3 text-zinc-400" />
                      {time}
                    </span>
                    <span className="text-zinc-300 dark:text-zinc-700">•</span>
                    <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold">
                      #{score.id.slice(0, 6).toUpperCase()}
                    </span>
                    {e && (
                      <>
                        <span className="text-zinc-300 dark:text-zinc-700">•</span>
                        <span className="text-zinc-500 dark:text-zinc-400 truncate max-w-[180px]">
                          {e.name}
                        </span>
                      </>
                    )}
                  </div>

                  <div className="text-xs text-zinc-700 dark:text-zinc-300 leading-relaxed">
                    <strong className="text-zinc-900 dark:text-white font-semibold">
                      {j?.name || 'Judge'}
                    </strong>{' '}
                    securely committed{' '}
                    <strong className="text-emerald-600 dark:text-emerald-400 font-mono font-bold">
                      {score.total_score} pts
                    </strong>{' '}
                    for{' '}
                    <strong className="text-zinc-900 dark:text-white font-semibold">
                      {p?.name || 'Participant'}
                    </strong>
                    {p?.sl_no && (
                      <span className="ml-1.5 font-mono text-[10px] px-1.5 py-0.5 rounded bg-stone-200/70 dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400">
                        #{p.sl_no}
                      </span>
                    )}
                  </div>

                  {Object.keys(breakdown).length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {Object.entries(breakdown).map(([critId, mark]) => (
                        <span
                          key={critId}
                          className="px-2 py-0.5 rounded-md bg-white dark:bg-zinc-950 border border-stone-200/80 dark:border-zinc-800/80 text-[10px] font-mono text-zinc-500 dark:text-zinc-400"
                        >
                          {critId.replace('crit_', '').replace(/_/g, ' ')}:{' '}
                          <strong className="text-zinc-800 dark:text-zinc-200">{String(mark)}</strong>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 2-CHOICE PDF EXPORT MODAL */}
      {isPdfModalOpen && (
        <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-zinc-950 w-full max-w-md rounded-2xl border border-stone-200 dark:border-zinc-800 shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-4 border-b border-stone-200 dark:border-zinc-800 flex justify-between items-center">
              <div>
                <h3 className="font-bold text-sm text-zinc-900 dark:text-white">
                  Export Official Results (.pdf)
                </h3>
                <p className="text-[11px] text-zinc-500">
                  Generates a clean standalone printable document
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsPdfModalOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-stone-100 dark:bg-zinc-900 text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <button
                type="button"
                onClick={() => executePDFExport('top3')}
                className="w-full text-left p-4 rounded-xl border border-stone-200 dark:border-zinc-800 hover:border-emerald-500/60 dark:hover:border-emerald-500/60 bg-stone-50/50 dark:bg-zinc-900/40 transition-all active:scale-[0.98] flex items-start gap-3 cursor-pointer"
              >
                <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 shrink-0">
                  <Trophy className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-bold text-sm text-zinc-900 dark:text-white">
                    Top 3 Winners Only
                  </div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    Clean podium summary across all events for certificates and press releases.
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => executePDFExport('full')}
                className="w-full text-left p-4 rounded-xl border border-stone-200 dark:border-zinc-800 hover:border-zinc-400 dark:hover:border-zinc-600 bg-stone-50/50 dark:bg-zinc-900/40 transition-all active:scale-[0.98] flex items-start gap-3 cursor-pointer"
              >
                <div className="p-2.5 rounded-xl bg-stone-200/70 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 shrink-0">
                  <FileText className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-bold text-sm text-zinc-900 dark:text-white">
                    Full Detailed Roster &amp; Scores
                  </div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    Complete event and category-wise table of every participant and final score.
                  </div>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}
    </PullToRefresh>
  );
}
