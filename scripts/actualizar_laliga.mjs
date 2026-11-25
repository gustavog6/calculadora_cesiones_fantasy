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

  for (const ev of schedRes.events || []) {
    const comp = ev.competitions?.[0];
    if (!comp?.status?.type?.completed) continue;
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
    rosterPlayers
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
    playerStats[key] = {
      goals: p.goals,
      assists: p.assists,
      saves: p.saves,
      appearances: p.appearances
    };
  }

  const output = {
    updated_at: new Date().toISOString(),
    season: stJson?.children?.[0]?.name || 'LALIGA',
    source: 'ESPN Public API (esp.1)',
    standings,
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
