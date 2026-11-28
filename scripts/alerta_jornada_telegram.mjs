#!/usr/bin/env node
/**
 * Publica alertas automáticas en el canal de Telegram ~15 minutos antes de iniciar:
 *   1. El primer partido de la jornada (aviso de cierre de LALIGA Fantasy).
 *   2. El primer partido de cada día siguiente de la jornada (sábado, domingo, lunes).
 *
 * Variables de entorno requeridas para enviar:
 *   TELEGRAM_BOT_TOKEN  Token del bot creado con @BotFather
 *   TELEGRAM_CHAT_ID    ID o @usuario del canal (ej. @clausulamesta)
 *
 * Flags opcionales:
 *   --dry-run   Muestra el mensaje en consola sin enviarlo ni modificar estado
 *   --force     Ignora la ventana de 15 minutos y el estado previo (útil para pruebas)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LALIGA_PATH = path.resolve(__dirname, '..', 'data', 'laliga.json');
const STATE_PATH = path.resolve(__dirname, '..', 'data', 'estado_alertas.json');
const SITE_URL = (process.env.SITE_URL || 'https://clausulamesta.club/').replace(/\/?$/, '/');
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force') || process.env.FORCE_SEND === 'true';

// Ventana de disparo: entre 1 y 24 minutos antes del inicio (absorbe jitter de GitHub Actions)
const MIN_LEAD_MIN = 1;
const MAX_LEAD_MIN = 24;

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getMadridDayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }); // YYYY-MM-DD
}

function formatMadridTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Madrid'
  });
}

function formatMadridWeekday(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-ES', {
    weekday: 'long',
    day: '2-digit',
    month: 'short',
    timeZone: 'Europe/Madrid'
  });
}

function groupMatchesByDay(matches) {
  const byDay = new Map();
  const sorted = (matches || []).slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  for (const m of sorted) {
    const dayKey = getMadridDayKey(m.date);
    if (!dayKey) continue;
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push(m);
  }
  return Array.from(byDay.entries()).map(([dayKey, dayMatches], index) => ({
    dayKey,
    isJornadaStart: index === 0,
    firstKickoffUtc: dayMatches[0].date,
    matches: dayMatches
  }));
}

function buildAlertMessage(dayGroup, minsLeft) {
  const first = dayGroup.matches[0];
  const kickoffStr = formatMadridTime(dayGroup.firstKickoffUtc);
  const dayLabel = formatMadridWeekday(dayGroup.firstKickoffUtc);
  const minsLabel = minsLeft > 0 && minsLeft <= 30 ? `${Math.round(minsLeft)} min` : '15 min';

  const lines = [];

  if (dayGroup.isJornadaStart) {
    lines.push(`⏰ <b>¡Faltan ${escHtml(minsLabel)} para iniciar la jornada de LaLiga!</b>`, '');
  } else {
    lines.push(`⚽ <b>¡En ${escHtml(minsLabel)} arrancan los partidos de hoy (${escHtml(dayLabel)})!</b>`, '');
  }

  if (first && first.home && first.away) {
    lines.push(
      `🏟️ <b>Primer partido:</b> ${escHtml(first.home.team)} vs ${escHtml(first.away.team)}` +
      (kickoffStr ? ` (${escHtml(kickoffStr)} h ESP)` : '')
    );
  }

  const rest = dayGroup.matches.slice(1);
  if (rest.length > 0) {
    lines.push('', '📅 <b>Resto de partidos hoy:</b>');
    rest.forEach((m) => {
      const t = formatMadridTime(m.date);
      lines.push(`• ${escHtml(m.home.team)} vs ${escHtml(m.away.team)}${t ? ` (${escHtml(t)} h)` : ''}`);
    });
  }

  if (dayGroup.isJornadaStart) {
    lines.push(
      '',
      '✅ <b>Checklist rápido antes del cierre:</b>',
      '• Revisa tu 11 titular, capitán y banquillo',
      '• Comprueba que tu saldo esté en positivo',
      '• Revisa alineaciones confirmadas y últimos clausulazos'
    );
  } else {
    lines.push(
      '',
      '📋 Ya puedes consultar las <b>alineaciones confirmadas</b> y seguir los <b>marcadores en vivo</b> en Clausulamesta.'
    );
  }

  lines.push(
    '',
    `🔴 <a href="${SITE_URL}?view=laliga&amp;tab=jornada">Ver jornada en vivo y alineaciones</a> · <a href="${SITE_URL}">Abrir Clausulamesta</a>`
  );

  return lines.join('\n');
}

async function readState() {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function main() {
  const raw = await fs.readFile(LALIGA_PATH, 'utf8');
  const data = JSON.parse(raw);
  const matchday = data && data.matchday;
  if (!matchday || !Array.isArray(matchday.matches) || matchday.matches.length === 0) {
    process.stdout.write('No hay partidos de jornada (matchday.matches) en data/laliga.json.\n');
    return;
  }

  const dayGroups = groupMatchesByDay(matchday.matches);
  const nowMs = Date.now();
  const state = await readState();
  const notifiedDays = (state && typeof state.notified_days === 'object' && state.notified_days) ? { ...state.notified_days } : {};

  // Buscar el día de jornada cuya hora de inicio esté dentro de la ventana de 1..24 min
  let targetGroup = null;
  let targetMinsLeft = null;

  for (const g of dayGroups) {
    const kMs = Date.parse(g.firstKickoffUtc);
    if (!Number.isFinite(kMs)) continue;
    const minsLeft = (kMs - nowMs) / 60000;
    if (minsLeft >= MIN_LEAD_MIN && minsLeft <= MAX_LEAD_MIN) {
      targetGroup = g;
      targetMinsLeft = minsLeft;
      break;
    }
  }

  // En modo --dry-run o --force, elegir el próximo día pendiente (o el primero si ya pasaron todos)
  if (!targetGroup && (DRY_RUN || FORCE)) {
    const upcoming = dayGroups.find((g) => Date.parse(g.firstKickoffUtc) > nowMs) || dayGroups[0];
    targetGroup = upcoming;
    targetMinsLeft = (Date.parse(upcoming.firstKickoffUtc) - nowMs) / 60000;
  }

  if (!targetGroup) {
    const nextUpcoming = dayGroups.find((g) => Date.parse(g.firstKickoffUtc) > nowMs);
    if (nextUpcoming) {
      const mins = ((Date.parse(nextUpcoming.firstKickoffUtc) - nowMs) / 60000).toFixed(1);
      process.stdout.write(`Fuera de ventana de aviso (próximo inicio: ${nextUpcoming.dayKey} ${nextUpcoming.firstKickoffUtc}, faltan ${mins} min).\n`);
    } else {
      process.stdout.write('No quedan días de jornada por iniciar en data/laliga.json.\n');
    }
    return;
  }

  if (!DRY_RUN && !FORCE && notifiedDays[targetGroup.dayKey]) {
    process.stdout.write(`El aviso del día ${targetGroup.dayKey} ya fue enviado previamente.\n`);
    return;
  }

  const text = buildAlertMessage(targetGroup, targetMinsLeft);

  if (DRY_RUN) {
    process.stdout.write(text + '\n');
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    process.stdout.write('TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no configurados; se omite el envío.\n');
    return;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.ok) {
    throw new Error(`Error enviando alerta de jornada a Telegram (${res.status}): ${payload.description || 'desconocido'}`);
  }

  notifiedDays[targetGroup.dayKey] = new Date().toISOString();
  // Conservar únicamente los últimos 20 días registrados
  const trimmedKeys = Object.keys(notifiedDays).sort().slice(-20);
  const cleanNotifiedDays = {};
  for (const k of trimmedKeys) cleanNotifiedDays[k] = notifiedDays[k];

  await writeState({
    last_kickoff_notified: targetGroup.firstKickoffUtc,
    notified_at: new Date().toISOString(),
    notified_days: cleanNotifiedDays
  });

  process.stdout.write(`Alerta enviada correctamente a ${chatId} (${targetGroup.dayKey}, inicio jornada=${targetGroup.isJornadaStart}).\n`);
}

main().catch((err) => {
  process.stderr.write(`Error en alerta_jornada_telegram: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
});
