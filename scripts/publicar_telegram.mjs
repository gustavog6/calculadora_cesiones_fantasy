#!/usr/bin/env node
/**
 * Publica el resumen diario del mercado de LALIGA Fantasy en un canal de Telegram
 * usando `data/players.json` (sin dependencias externas, 100% gratis desde GitHub Actions).
 *
 * Variables de entorno requeridas para enviar:
 *   TELEGRAM_BOT_TOKEN  Token del bot creado con @BotFather
 *   TELEGRAM_CHAT_ID    ID o @usuario del canal (ej. @clausulamesta)
 *
 * Uso local en modo vista previa:
 *   node scripts/publicar_telegram.mjs --dry-run
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAYERS_PATH = path.resolve(__dirname, '..', 'data', 'players.json');
const SITE_URL = (process.env.SITE_URL || 'https://gustavog6.github.io/clausulamesta/').replace(/\/?$/, '/');
const DRY_RUN = process.argv.includes('--dry-run');

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtEuros(n) {
  const neg = n < 0;
  const ent = Math.round(Math.abs(n));
  const str = String(ent).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '-' : '') + str + ' €';
}

function fmtCompact(n) {
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + 'M €';
  if (abs >= 1e3) return Math.round(n / 1e3) + 'k €';
  return fmtEuros(n);
}

function buildMessage(data) {
  const players = Array.isArray(data.players) ? data.players : [];
  if (players.length === 0) throw new Error('data/players.json no contiene jugadores.');

  const topRisers = players
    .filter((p) => typeof p.price_increment === 'number' && p.price_increment > 0)
    .sort((a, b) => b.price_increment - a.price_increment)
    .slice(0, 5);

  const topFallers = players
    .filter((p) => typeof p.price_increment === 'number' && p.price_increment < 0)
    .sort((a, b) => a.price_increment - b.price_increment)
    .slice(0, 5);

  const chollos = players
    .filter((p) => typeof p.price === 'number' && p.price > 0 && p.price <= 10_000_000 && typeof p.price_increment === 'number' && p.price_increment > 0)
    .map((p) => {
      const prev = p.price - p.price_increment;
      const pct = prev > 0 ? (p.price_increment / prev) * 100 : 0;
      return { ...p, pct };
    })
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 3);

  const fecha = new Date().toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Europe/Madrid'
  });

  const lines = [
    `⚽ <b>Clausulamesta · Mercado LALIGA Fantasy</b> (${escHtml(fecha)})`,
    '',
    '🔥 <b>Top 5 Subidas de hoy</b>'
  ];

  topRisers.forEach((p, i) => {
    lines.push(`${i + 1}. <b>${escHtml(p.name)}</b> (${escHtml(p.team)}) · <b>+${escHtml(fmtCompact(p.price_increment))}</b> · ${escHtml(fmtCompact(p.price))}`);
  });

  lines.push('', '📉 <b>Top 5 Bajadas de hoy</b>');
  topFallers.forEach((p, i) => {
    lines.push(`${i + 1}. <b>${escHtml(p.name)}</b> (${escHtml(p.team)}) · <b>${escHtml(fmtCompact(p.price_increment))}</b> · ${escHtml(fmtCompact(p.price))}`);
  });

  if (chollos.length > 0) {
    lines.push('', '💎 <b>Top 3 Chollos (&lt; 10M €)</b>');
    chollos.forEach((p, i) => {
      lines.push(`${i + 1}. <b>${escHtml(p.name)}</b> (${escHtml(p.team)}) · +${p.pct.toFixed(1).replace('.', ',')}% (+${escHtml(fmtCompact(p.price_increment))}) · ${escHtml(fmtCompact(p.price))}`);
    });
  }

  const compareIds = topRisers.map((p) => p.id).join(',');
  lines.push(
    '',
    `📊 <a href="${SITE_URL}?compare=${encodeURIComponent(compareIds)}">Comparar el Top 5 subidas</a> · <a href="${SITE_URL}">Abrir Clausulamesta</a>`
  );

  return lines.join('\n');
}

async function main() {
  const raw = await fs.readFile(PLAYERS_PATH, 'utf8');
  const data = JSON.parse(raw);
  const text = buildMessage(data);

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

  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(`Telegram API error (${res.status}): ${JSON.stringify(body)}`);
  }

  process.stdout.write(`Resumen diario publicado en Telegram (chat ${chatId}).\n`);
}

main().catch((err) => {
  process.stderr.write(`Error publicando en Telegram: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
});
