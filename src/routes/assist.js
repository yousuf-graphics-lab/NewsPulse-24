'use strict';

/**
 * AI assistant endpoints.
 *
 * `POST /api/assistant/stream` is a Server-Sent-Events stream. The widget reads
 * it with fetch + a ReadableStream reader (EventSource cannot POST), so the
 * question body never appears in a URL or a log.
 */

const express = require('express');
const crypto = require('node:crypto');
const ai = require('../services/ai');
const security = require('../middleware/security');
const config = require('../config');
const settings = require('../services/content');

const router = express.Router();

const CHAT_COOKIE = 'np_chat';

function ensureChatId(req, res) {
  let id = req.cookies?.[CHAT_COOKIE];
  if (!id || typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(id)) {
    id = crypto.randomBytes(12).toString('base64url');
    res.cookie(CHAT_COOKIE, id, {
      httpOnly: true, sameSite: 'lax', secure: config.isProd,
      maxAge: 1000 * 60 * 60 * 24 * 30, path: '/',
    });
  }
  return id;
}

function historyFor(chatId) {
  try {
    const rows = require('../db').all(
      `SELECT role, content FROM assistant_chats WHERE chat_id = ? ORDER BY id DESC LIMIT 8`,
      [chatId],
    );
    return rows.reverse();
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------- config -- */

router.get('/api/assistant/config', (req, res) => {
  res.json({
    ok: true,
    enabled: settings.getSetting('assistant_enabled', '1') === '1',
    greeting: req.locale === 'en'
      ? settings.getSetting('assistant_greeting_en')
      : settings.getSetting('assistant_greeting_bn'),
    suggestions: req.locale === 'en'
      ? ['What is trending today?', 'Latest cricket news', 'Top 5 stories right now', 'How do I subscribe to the newsletter?']
      : ['আজ কী ট্রেন্ডিং?', 'সর্বশেষ ক্রিকেট খবর', 'এখনকার সেরা ৫টি সংবাদ', 'নিউজলেটারে সাবস্ক্রাইব করব কীভাবে?'],
    provider: ai.providerConfig() ? 'remote' : 'local',
  });
});

/* ------------------------------------------------------------------ chat -- */

router.post('/api/assistant/chat', security.limiters.ai(), async (req, res, next) => {
  try {
    const question = String(req.body?.message || '').slice(0, config.ai.maxMessageChars);
    if (!question.trim()) return res.status(400).json({ ok: false, error: 'empty_message' });

    req.chatId = ensureChatId(req, res);
    const answer = await ai.ask({ question, req, history: historyFor(req.chatId) });
    res.json({ ok: true, ...answer });
  } catch (err) { next(err); }
});

router.post('/api/assistant/stream', security.limiters.ai(), async (req, res) => {
  const question = String(req.body?.message || '').slice(0, config.ai.maxMessageChars);
  if (!question.trim()) { res.status(400).json({ ok: false, error: 'empty_message' }); return; }

  req.chatId = ensureChatId(req, res);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    for await (const chunk of ai.askStream({ question, req, history: historyFor(req.chatId) })) {
      if (aborted) break;
      send(chunk.type, chunk);
    }
  } catch (err) {
    send('error', { message: 'assistant_error' });
    security.logSecurityEvent({ kind: 'ai_stream_error', severity: 'medium', req, detail: String(err.message).slice(0, 200) });
  } finally {
    if (!aborted) res.end();
  }
});

/* ---------------------------------------------------- admin transcript ---- */

router.get('/api/assistant/history', (req, res) => {
  const chatId = ensureChatId(req, res);
  res.json({ ok: true, chatId, messages: historyFor(chatId) });
});

module.exports = router;
