#!/usr/bin/env node
/**
 * Publica una alerta automática en el canal de Telegram cuando faltan ~15 minutos
 * para que comience el primer partido de la jornada de LaLiga (`data/laliga.json`).
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

function formatMadridTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Madrid'
  });
}

function buildAlertMessage(matchday, minsLeft) {
  const matches = Array.isArray(matchday.matches) ? matchday.matches : [];
  const first = matches[0];
  const kickoffStr = formatMadridTime(matchday.firstKickoffUtc);
  const minsLabel = minsLeft > 0 && minsLeft <= 30 ? `${Math.round(minsLeft)} min` : '15 min';

  const lines = [
    `⏰ <b>¡Faltan ${escHtml(minsLabel)} para iniciar la jornada de LaLiga!</b>`,
    ''
  ];

  if (first && first.home && first.away) {
    lines.push(
      `🏟️ <b>Primer partido:</b> ${escHtml(first.home.team)} vs ${escHtml(first.away.team)}` +
      (kickoffStr ? ` (${escHtml(kickoffStr)} h ESP)` : '')
    );
  }

  // Mostrar también los partidos del mismo día si hay varios
  const firstDay = String(matchday.firstKickoffUtc || '').slice(0, 10);
  const sameDay = matches.slice(1).filter((m) => String(m.date || '').slice(0, 10) === firstDay);
  if (sameDay.length > 0) {
    lines.push('', '📅 <b>Más partidos hoy:</b>');
    sameDay.forEach((m) => {
      const t = formatMadridTime(m.date);
      lines.push(`• ${escHtml(m.home.team)} vs ${escHtml(m.away.team)}${t ? ` (${escHtml(t)} h)` : ''}`);
    });
  }

  lines.push(
    '',
    '✅ <b>Checklist rápido antes del cierre:</b>',
    '• Revisa tu 11 titular, capitán y banquillo',
    '• Comprueba que tu saldo esté en positivo',
    '• Revisa alineaciones confirmadas y últimos clausulazos',
    '',
    `📋 <a href="${SITE_URL}?view=laliga&amp;tab=jornada">Ver jornada y alineaciones confirmadas</a> · <a href="${SITE_URL}">Abrir Clausulamesta</a>`
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
  if (!matchday || !matchday.firstKickoffUtc) {
    process.stdout.write('No hay datos de jornada (matchday.firstKickoffUtc) en data/laliga.json.\n');
    return;
  }

  const kickoffMs = Date.parse(matchday.firstKickoffUtc);
  if (!Number.isFinite(kickoffMs)) {
    process.stdout.write('Fecha de inicio de jornada inválida.\n');
    return;
  }

  const minsLeft = (kickoffMs - Date.now()) / 60000;
  const state = await readState();
  const alreadySent = state.last_kickoff_notified === matchday.firstKickoffUtc;

  if (!DRY_RUN && !FORCE) {
    if (alreadySent) {
      process.stdout.write(`Jornada ${matchday.firstKickoffUtc} ya fue notificada previamente.\n`);
      return;
    }
    if (minsLeft < MIN_LEAD_MIN || minsLeft > MAX_LEAD_MIN) {
      process.stdout.write(`Fuera de ventana de aviso (faltan ${minsLeft.toFixed(1)} min para ${matchday.firstKickoffUtc}).\n`);
      return;
    }
  }

  const text = buildAlertMessage(matchday, minsLeft);

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

  await writeState({
    ...state,
    last_kickoff_notified: matchday.firstKickoffUtc,
    notified_at: new Date().toISOString()
  });

  process.stdout.write(`Alerta de inicio de jornada enviada correctamente a ${chatId}.\n`);
}

main().catch((err) => {
  process.stderr.write(`Error en alerta_jornada_telegram: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
});
