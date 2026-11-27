#!/usr/bin/env node
/**
 * Descarga clasificación de LaLiga (General / Casa / Visitante), racha (últimos 5 L/V),
 * calendario (próximos 5 L/V) y estadísticas individuales (goles, asistencias, paradas)
 * desde la API pública de ESPN (`esp.1`) y genera `data/laliga.json`.
 *
 * Uso:
 *   node scripts/actualizar_laliga.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_V2 = 'https://site.api.espn.com/apis/v2/sports/soccer/esp.1';
const BASE_SITE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1';
const TIMEOUT_MS = 18000;
const MAX_RETRIES = 3;
const CONCURRENCY = 5;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(__dirname, '..', 'data', 'laliga.json');

/**
 * Normaliza cadenas quitando acentos, signos y mayúsculas para cruces fiables.
 * @param {string} s
 * @returns {string}
 */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mapea nombres de equipos de ESPN al nombre usado en `data/players.json`.
 * @param {string} espnName
 * @returns {string}
 */
function toFantasyTeamName(espnName) {
  const n = norm(espnName);
  const rules = [
    ['alaves', 'Alavés'],
    ['athletic', 'Athletic'],
    ['atletico', 'Atlético'],
    ['barcelona', 'Barcelona'],
    ['betis', 'Betis'],
    ['celta', 'Celta'],
    ['deportivo la coruna', 'Deportivo'],
    ['coruna', 'Deportivo'],
    ['elche', 'Elche'],
    ['espanyol', 'Espanyol'],
    ['getafe', 'Getafe'],
    ['girona', 'Girona'],
    ['las palmas', 'Las Palmas'],
    ['leganes', 'Leganés'],
    ['levante', 'Levante'],
    ['malaga', 'Málaga'],
    ['mallorca', 'Mallorca'],
    ['osasuna', 'Osasuna'],
    ['racing', 'Racing'],
    ['rayo', 'Rayo Vallecano'],
    ['real madrid', 'Real Madrid'],
    ['real sociedad', 'Real Sociedad'],
    ['sevilla', 'Sevilla'],
    ['valencia', 'Valencia'],
    ['valladolid', 'Valladolid'],
    ['villarreal', 'Villarreal']
  ];
  for (const [needle, target] of rules) {
    if (n.includes(needle)) return target;
  }
  return espnName;
}

/**
 * Normaliza posición de ESPN a DEL/MED/DEF/POR.
 * @param {string} abbr
 * @returns {string}
 */
function mapPosition(abbr) {
  const a = String(abbr || '').toUpperCase();
  if (a === 'G' || a === 'GK') return 'POR';
  if (a === 'D' || a === 'DF' || a === 'DEF' || a === 'CB' || a === 'LB' || a === 'RB') return 'DEF';
  if (a === 'M' || a === 'MF' || a === 'MID' || a === 'CM' || a === 'DM' || a === 'AM') return 'MED';
  if (a === 'F' || a === 'FW' || a === 'ST' || a === 'CF' || a === 'LW' || a === 'RW') return 'DEL';
  return '';
}

async function fetchJson(url) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'clausulamesta-laliga-updater/1.0'
        }
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
  }
  throw lastErr;
}

function emptySplit() {
  return { pj: 0, pts: 0, v: 0, e: 0, d: 0, gf: 0, gc: 0, dg: 0 };
}

function addMatchToSplit(split, gf, gc) {
  split.pj += 1;
  split.gf += gf;
  split.gc += gc;
  split.dg = split.gf - split.gc;
  if (gf > gc) { split.v += 1; split.pts += 3; }
  else if (gf === gc) { split.e += 1; split.pts += 1; }
  else { split.d += 1; }
}

function parseScore(comp) {
  if (!comp) return null;
  if (typeof comp.score === 'number') return comp.score;
  if (comp.score && typeof comp.score.value === 'number') return comp.score.value;
  if (comp.score && typeof comp.score.displayValue === 'string') {
    const n = Number(comp.score.displayValue);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(comp.score);
  return Number.isFinite(n) ? n : null;
}

function extractStat(athlete, statName) {
  const cats = athlete?.statistics?.splits?.categories || [];
  for (const cat of cats) {
    for (const s of cat.stats || []) {
      if (s.name === statName && typeof s.value === 'number' && Number.isFinite(s.value)) {
        return Math.round(s.value);
      }
    }
  }
  return 0;
}

function parseClockMinute(displayValue) {
  const m = String(displayValue || '').match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.max(1, Math.min(90, n)) : null;
}

function calcPlayerMatchMinutes(entry) {
  const starter = Boolean(entry?.starter);
  const subbedIn = Boolean(entry?.subbedIn);
  const subbedOut = Boolean(entry?.subbedOut);
  if (!starter && !subbedIn) return 0;

  const plays = Array.isArray(entry?.plays) ? entry.plays : [];
  const subMins = plays
    .filter((p) => p && p.substitution)
    .map((p) => parseClockMinute(p.clock?.displayValue))
    .filter((n) => n !== null);
  const redMin = plays
    .filter((p) => p && p.redCard)
    .map((p) => parseClockMinute(p.clock?.displayValue))
    .find((n) => n !== null) || null;

  if (starter) {
    if (subbedOut && subMins.length > 0) return subMins[0];
    if (redMin !== null) return redMin;
    return 90;
  }

  // Entró desde el banquillo
  const inMin = subMins.length > 0 ? subMins[0] : null;
  if (inMin === null) return 0;
  if (subbedOut && subMins.length > 1) return Math.max(1, subMins[1] - inMin);
  if (redMin !== null && redMin >= inMin) return Math.max(1, redMin - inMin);
  return Math.max(1, 90 - inMin);
}

async function fetchMatchMinutesByPlayer(eventIds) {
  const minutesMap = new Map();
  const summaries = await mapConcurrent(eventIds, 8, (evId) =>
    fetchJson(`${BASE_SITE}/summary?event=${encodeURIComponent(evId)}`).catch(() => null)
  );

  for (const sum of summaries) {
    if (!sum || !Array.isArray(sum.rosters)) continue;
    for (const teamRoster of sum.rosters) {
      const teamName = toFantasyTeamName(teamRoster?.team?.displayName || teamRoster?.team?.name || '');
      if (!teamName) continue;
      for (const entry of teamRoster.roster || []) {
        const athName = entry?.athlete?.displayName || entry?.athlete?.fullName || '';
        if (!athName) continue;
        const mins = calcPlayerMatchMinutes(entry);
        const isStarter = Boolean(entry?.starter);
        if (mins <= 0 && !isStarter) continue;
        const key = `${norm(teamName)}::${norm(athName)}`;
        const prev = minutesMap.get(key) || { minutes: 0, starts: 0 };
        prev.minutes += mins;
        if (isStarter) prev.starts += 1;
        minutesMap.set(key, prev);
      }
    }
  }
  return minutesMap;
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const current = idx;
      idx += 1;
      results[current] = await fn(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function processTeam(entry) {
  const team = entry.team || {};
  const teamId = String(team.id);
  const displayName = team.displayName || team.name || '';
  const fantasyTeam = toFantasyTeamName(displayName);
  const abbr = team.abbreviation || fantasyTeam.slice(0, 3).toUpperCase();
  const logo = team.logos?.[0]?.href || '';

  const statsMap = {};
  for (const s of entry.stats || []) {
    statsMap[s.name] = typeof s.value === 'number' ? s.value : Number(s.displayValue);
  }

  const [schedRes, fixRes, rosterRes] = await Promise.all([
    fetchJson(`${BASE_SITE}/teams/${teamId}/schedule`),
    fetchJson(`${BASE_SITE}/teams/${teamId}/schedule?fixture=true`),
    fetchJson(`${BASE_SITE}/teams/${teamId}/roster`)
  ]);

  const home = emptySplit();
  const away = emptySplit();
  const completedMatches = [];
  const completedEventIds = [];

  for (const ev of schedRes.events || []) {
    const comp = ev.competitions?.[0];
    if (!comp?.status?.type?.completed) continue;
    if (ev.id) completedEventIds.push(String(ev.id));
    const comps = comp.competitors || [];
    const me = comps.find((c) => String(c.team?.id) === teamId);
    const opp = comps.find((c) => String(c.team?.id) !== teamId);
    if (!me || !opp) continue;

    const gf = parseScore(me);
    const gc = parseScore(opp);
    if (gf === null || gc === null) continue;

    const isHome = me.homeAway === 'home';
    addMatchToSplit(isHome ? home : away, gf, gc);

    const res = gf > gc ? 'V' : (gf === gc ? 'E' : 'D');
    completedMatches.push({
      date: ev.date || '',
      res,
      loc: isHome ? 'L' : 'V',
      opp: toFantasyTeamName(opp.team?.displayName || opp.team?.shortDisplayName || ''),
      oppAbbr: opp.team?.abbreviation || '',
      score: `${gf}-${gc}`
    });
  }

  completedMatches.sort((a, b) => a.date.localeCompare(b.date));
  const form = completedMatches.slice(-5);

  const general = {
    pj: Number.isFinite(statsMap.gamesPlayed) ? statsMap.gamesPlayed : home.pj + away.pj,
    pts: Number.isFinite(statsMap.points) ? statsMap.points : home.pts + away.pts,
    v: Number.isFinite(statsMap.wins) ? statsMap.wins : home.v + away.v,
    e: Number.isFinite(statsMap.ties) ? statsMap.ties : home.e + away.e,
    d: Number.isFinite(statsMap.losses) ? statsMap.losses : home.d + away.d,
    gf: Number.isFinite(statsMap.pointsFor) ? statsMap.pointsFor : home.gf + away.gf,
    gc: Number.isFinite(statsMap.pointsAgainst) ? statsMap.pointsAgainst : home.gc + away.gc,
    dg: Number.isFinite(statsMap.pointDifferential) ? statsMap.pointDifferential : (home.dg + away.dg)
  };

  const upcomingRaw = [];
  for (const ev of fixRes.events || []) {
    const comp = ev.competitions?.[0];
    if (comp?.status?.type?.completed) continue;
    const comps = comp?.competitors || [];
    const me = comps.find((c) => String(c.team?.id) === teamId);
    const opp = comps.find((c) => String(c.team?.id) !== teamId);
    if (!me || !opp) continue;
    upcomingRaw.push({
      date: ev.date || '',
      loc: me.homeAway === 'home' ? 'L' : 'V',
      opp: toFantasyTeamName(opp.team?.displayName || opp.team?.shortDisplayName || ''),
      oppAbbr: opp.team?.abbreviation || ''
    });
  }
  upcomingRaw.sort((a, b) => a.date.localeCompare(b.date));
  const upcoming = upcomingRaw.slice(0, 5);

  const rosterPlayers = [];
  for (const ath of rosterRes.athletes || []) {
    const name = ath.displayName || ath.fullName || '';
    if (!name) continue;
    const goals = extractStat(ath, 'totalGoals');
    const assists = extractStat(ath, 'goalAssists');
    const saves = extractStat(ath, 'saves');
    const appearances = extractStat(ath, 'appearances');
    rosterPlayers.push({
      espnId: String(ath.id || ''),
      name,
      team: fantasyTeam,
      teamAbbr: abbr,
      teamLogo: logo,
      position: mapPosition(ath.position?.abbreviation),
      goals,
      assists,
      saves,
      appearances
    });
  }

  return {
    standing: {
      id: teamId,
      rank: Number.isFinite(statsMap.rank) ? statsMap.rank : 0,
      team: fantasyTeam,
      espnName: displayName,
      abbr,
      logo,
      general,
      home,
      away,
      form,
      upcoming
    },
    rosterPlayers,
    completedEventIds,
    allEvents: [...(schedRes.events || []), ...(fixRes.events || [])]
  };
}

function formatEspnDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function normalizeScoreboardEvent(ev) {
  const comp = ev?.competitions?.[0];
  if (!comp) return null;
  const comps = comp.competitors || [];
  const homeComp = comps.find((c) => c.homeAway === 'home');
  const awayComp = comps.find((c) => c.homeAway === 'away');
  if (!homeComp || !awayComp) return null;

  const stType = comp.status?.type || {};
  const state = stType.state || 'pre'; // 'pre' | 'in' | 'post'
  return {
    id: String(ev.id || ''),
    date: ev.date || '',
    state,
    statusDetail: stType.shortDetail || stType.description || '',
    clock: comp.status?.displayClock || '',
    home: {
      id: String(homeComp.team?.id || ''),
      team: toFantasyTeamName(homeComp.team?.displayName || homeComp.team?.shortDisplayName || ''),
      abbr: homeComp.team?.abbreviation || '',
      logo: homeComp.team?.logo || homeComp.team?.logos?.[0]?.href || '',
      score: state === 'pre' ? null : parseScore(homeComp)
    },
    away: {
      id: String(awayComp.team?.id || ''),
      team: toFantasyTeamName(awayComp.team?.displayName || awayComp.team?.shortDisplayName || ''),
      abbr: awayComp.team?.abbreviation || '',
      logo: awayComp.team?.logo || awayComp.team?.logos?.[0]?.href || '',
      score: state === 'pre' ? null : parseScore(awayComp)
    }
  };
}

function buildCurrentMatchday(rawEvents) {
  const byId = new Map();
  for (const ev of rawEvents) {
    const normEv = normalizeScoreboardEvent(ev);
    if (normEv && normEv.id && !byId.has(normEv.id)) {
      byId.set(normEv.id, normEv);
    }
  }
  const nowMs = Date.now();
  const minMs = nowMs - 4 * 86400000;
  const maxMs = nowMs + 14 * 86400000;
  const events = Array.from(byId.values())
    .filter((ev) => {
      const t = Date.parse(ev.date);
      return Number.isFinite(t) && t >= minMs && t <= maxMs;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  if (events.length === 0) return null;

  // Agrupar partidos en jornadas: brecha > 48h O un equipo repetido inicia una jornada nueva
  const clusters = [];
  let seenTeams = new Set();
  for (const ev of events) {
    const t = Date.parse(ev.date);
    const hTeam = ev.home.team;
    const aTeam = ev.away.team;
    if (clusters.length === 0) {
      clusters.push([ev]);
      seenTeams = new Set([hTeam, aTeam]);
      continue;
    }
    const lastCluster = clusters[clusters.length - 1];
    const prevT = Date.parse(lastCluster[lastCluster.length - 1].date);
    const gapExceeded = Number.isFinite(t) && Number.isFinite(prevT) && (t - prevT) > 48 * 3600 * 1000;
    const teamRepeated = seenTeams.has(hTeam) || seenTeams.has(aTeam);
    if (gapExceeded || teamRepeated) {
      clusters.push([ev]);
      seenTeams = new Set([hTeam, aTeam]);
    } else {
      lastCluster.push(ev);
      seenTeams.add(hTeam);
      seenTeams.add(aTeam);
    }
  }

  // Elegir la jornada activa (con partidos en vivo o pendientes) o la más reciente
  const selected = clusters.find((c) => c.some((m) => m.state === 'in' || m.state === 'pre'))
    || clusters[clusters.length - 1];

  const firstDate = new Date(selected[0].date);
  const lastDate = new Date(selected[selected.length - 1].date);
  const datesParam = Number.isFinite(firstDate.getTime()) && Number.isFinite(lastDate.getTime())
    ? `${formatEspnDate(firstDate)}-${formatEspnDate(lastDate)}`
    : '';

  return {
    firstKickoffUtc: selected[0].date || '',
    datesParam,
    updatedAt: new Date().toISOString(),
    matches: selected
  };
}

async function main() {
  const stJson = await fetchJson(`${BASE_V2}/standings`);
  const entries = stJson?.children?.[0]?.standings?.entries || [];
  if (entries.length === 0) {
    throw new Error('ESPN no devolvió equipos en standings.');
  }

  const processed = await mapConcurrent(entries, CONCURRENCY, processTeam);
  const standings = processed.map((x) => x.standing).sort((a, b) => (a.rank || 99) - (b.rank || 99));
  standings.forEach((t, i) => { if (!t.rank) t.rank = i + 1; });

  const uniqueEventIds = Array.from(new Set(processed.flatMap((x) => x.completedEventIds || [])));
  const minutesByPlayer = await fetchMatchMinutesByPlayer(uniqueEventIds);
  const matchday = buildCurrentMatchday(processed.flatMap((x) => x.allEvents || []));

  const allRoster = processed.flatMap((x) => x.rosterPlayers);

  const scorers = allRoster
    .filter((p) => p.goals > 0)
    .sort((a, b) => b.goals - a.goals || b.assists - a.assists || a.appearances - b.appearances)
    .slice(0, 25);

  const assists = allRoster
    .filter((p) => p.assists > 0)
    .sort((a, b) => b.assists - a.assists || b.goals - a.goals || a.appearances - b.appearances)
    .slice(0, 25);

  const saves = allRoster
    .filter((p) => p.saves > 0)
    .sort((a, b) => b.saves - a.saves || a.appearances - b.appearances)
    .slice(0, 25);

  const playerStats = {};
  for (const p of allRoster) {
    const key = `${norm(p.team)}::${norm(p.name)}`;
    const minInfo = minutesByPlayer.get(key);
    playerStats[key] = {
      goals: p.goals,
      assists: p.assists,
      saves: p.saves,
      appearances: p.appearances,
      minutes: minInfo ? minInfo.minutes : undefined,
      starts: minInfo ? minInfo.starts : undefined
    };
  }
  for (const [key, minInfo] of minutesByPlayer.entries()) {
    if (!playerStats[key]) {
      playerStats[key] = {
        goals: 0,
        assists: 0,
        saves: 0,
        appearances: minInfo.starts,
        minutes: minInfo.minutes,
        starts: minInfo.starts
      };
    }
  }

  const output = {
    updated_at: new Date().toISOString(),
    season: stJson?.children?.[0]?.name || 'LALIGA',
    source: 'ESPN Public API (esp.1)',
    standings,
    matchday,
    leaders: { scorers, assists, saves },
    playerStats
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
  process.stdout.write(
    `Actualizado ${OUTPUT_PATH}: ${standings.length} equipos, ` +
    `${scorers.length} goleadores, ${assists.length} asistidores, ${saves.length} porteros con paradas.\n`
  );
}

main().catch((err) => {
  process.stderr.write(`Error actualizando LaLiga: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
});
