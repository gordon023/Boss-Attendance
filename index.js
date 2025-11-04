/**
 * Boss Attendance backend
 * - Express + Socket.IO
 * - Discord bot for voice state tracking (optional)
 * - OCR upload with tesseract.js
 * - Boss-list upload (text or image) -> parse boss name + spawn time
 *
 * Environment variables:
 *  - PORT (optional)
 *  - DISCORD_BOT_TOKEN (optional, required for voice detection)
 *  - DISCORD_WEBHOOK_URL (required to send updates)
 *  - VOICE_CHANNEL_ID (optional: the single voice channel id you want to track)
 */

import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import multer from 'multer';
import fs from 'fs-extra';
import path from 'path';
import cors from 'cors';
import Tesseract from 'tesseract.js';
import { Client, GatewayIntentBits } from 'discord.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

fs.ensureDirSync(UPLOAD_DIR);
fs.ensureDirSync(DATA_DIR);

// --- persistent state (saved to data/state.json) ---
let state = {
  bosses: [],            // { id, name, spawnISO, status: 'pending'|'active'|'done' }
  activeBoss: null,     // id of active boss or null
  attendanceRecords: [],// list of uploads: { id, file, detected: [], uploadedAt }
  voiceLog: {},         // userId -> { id, username, displayName, joinedAt, lastSeen, status:'in'|'out' }
  lastSummary: null     // last summary sent
};

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      state = fs.readJSONSync(DATA_FILE);
      // convert old dates if needed
    } else {
      fs.writeJSONSync(DATA_FILE, state, { spaces: 2 });
    }
  } catch (e) {
    console.error('Load state error', e);
  }
}
function saveState() {
  try {
    fs.writeJSONSync(DATA_FILE, state, { spaces: 2 });
  } catch (e) {
    console.error('Save state error', e);
  }
}
loadState();

// --- express + socket.io setup ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public'))); // serve frontend if any
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// --- multer storage for uploads ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`)
});
const upload = multer({ storage });

// --- Discord bot setup (optional) ---
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID || ''; // optional

let discordClient = null;
let discordReady = false;

if (DISCORD_BOT_TOKEN) {
  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences
    ]
  });

  discordClient.on('ready', () => {
    discordReady = true;
    console.log('Discord bot ready:', discordClient.user.tag);
    // If VOICE_CHANNEL_ID provided, populate initial members
    if (VOICE_CHANNEL_ID) populateVoiceMembersFromChannel(VOICE_CHANNEL_ID);
  });

  discordClient.on('voiceStateUpdate', (oldState, newState) => {
    try {
      // ignore bots
      const member = newState.member || oldState.member;
      if (!member || member.user.bot) return;

      const uid = member.id;
      const username = member.user.username;
      const displayName = member.displayName || username;
      const oldCid = oldState.channelId;
      const newCid = newState.channelId;

      // joined monitored channel
      if (newCid && newCid === VOICE_CHANNEL_ID && oldCid !== VOICE_CHANNEL_ID) {
        state.voiceLog[uid] = {
          id: uid,
          username,
          displayName,
          joinedAt: Date.now(),
          lastSeen: Date.now(),
          status: 'in'
        };
      }
      // left monitored channel
      else if (oldCid === VOICE_CHANNEL_ID && (!newCid || newCid !== VOICE_CHANNEL_ID)) {
        if (state.voiceLog[uid]) {
          state.voiceLog[uid].lastSeen = Date.now();
          state.voiceLog[uid].status = 'out';
        } else {
          // record quick leave
          state.voiceLog[uid] = {
            id: uid,
            username,
            displayName,
            joinedAt: null,
            lastSeen: Date.now(),
            status: 'out'
          };
        }
      } else if (newCid === VOICE_CHANNEL_ID) {
        // still in channel, update lastSeen
        if (state.voiceLog[uid]) state.voiceLog[uid].lastSeen = Date.now();
        else {
          state.voiceLog[uid] = {
            id: uid, username, displayName, joinedAt: Date.now(), lastSeen: Date.now(), status: 'in'
          };
        }
      }

      saveState();
      io.emit('voice_update', Object.values(state.voiceLog));
    } catch (err) {
      console.error('voiceStateUpdate err', err);
    }
  });

  // try login, but catch errors so process doesn't crash
  discordClient.login(DISCORD_BOT_TOKEN).catch(err => {
    discordReady = false;
    console.error('Discord login error (bot will be disabled):', err.message || err);
  });
} else {
  console.log('No DISCORD_BOT_TOKEN provided — Discord voice detection disabled.');
}

// helper to read channel members once (initial population)
async function populateVoiceMembersFromChannel(channelId) {
  try {
    if (!discordClient || !discordReady) return;
    const ch = await discordClient.channels.fetch(channelId);
    if (!ch || !ch.members) return;
    ch.members.forEach(m => {
      if (m.user.bot) return;
      state.voiceLog[m.id] = {
        id: m.id,
        username: m.user.username,
        displayName: m.displayName || m.user.username,
        joinedAt: Date.now(),
        lastSeen: Date.now(),
        status: 'in'
      };
    });
    saveState();
    io.emit('voice_update', Object.values(state.voiceLog));
  } catch (e) {
    console.warn('populateVoiceMembersFromChannel error', e.message || e);
  }
}

// --- Utility: build discord message content ---
function buildDiscordMessage(activeBossObj, attendanceList, voiceMembersMap) {
  const bossName = activeBossObj ? activeBossObj.name : 'No active boss';
  const dateStr = new Date().toLocaleString();
  let lines = [];
  lines.push(`**Boss Attendance Report — ${bossName}**`);
  lines.push(`Date: ${dateStr}`);
  lines.push('');

  // attendanceList: array of names (from OCR)
  if (!attendanceList || attendanceList.length === 0) lines.push('_No attendance names detected_');
  else {
    lines.push('**Detected from image:**');
    attendanceList.forEach((n, i) => lines.push(`${i+1}. ${n}`));
  }
  lines.push('');

  // voiceMembersMap: { userId: {displayName, status, joinedAt, lastSeen } }
  const present = [];
  const absent = [];

  // Build mapping by name normalization: compare normalized strings
  const norm = s => (s || '').toString().toLowerCase().replace(/\s+/g, '');

  const detectedNorm = (attendanceList||[]).map(n => norm(n));

  // Check each voice member against attendance list
  for (const [uid, v] of Object.entries(voiceMembersMap || {})) {
    if (v.status !== 'in') continue;
    const nameNorm = norm(v.displayName || v.username);
    const matched = detectedNorm.filter(dn => dn && (nameNorm.includes(dn) || dn.includes(nameNorm)));
    if (matched.length) present.push(`${v.displayName || v.username}`);
    else {
      // if not matched but was in attendance list? -> absent or unknown
      absent.push(`${v.displayName || v.username} (not in image list)`);
    }
  }

  // Names from attendance that are not in VC -> absent
  const vcNames = Object.values(voiceMembersMap || {}).filter(x => x.status === 'in').map(x => norm(x.displayName || x.username));
  (attendanceList||[]).forEach(n => {
    const nrm = norm(n);
    const found = vcNames.some(vn => vn.includes(nrm) || nrm.includes(vn));
    if (!found) absent.push(`${n} (absent from voice)`);
  });

  lines.push('**Present (in VC & matched):**');
  if (present.length) present.forEach((p,i) => lines.push(`${i+1}. ${p}`));
  else lines.push('_None_');

  lines.push('');
  lines.push('**Absent / mismatches:**');
  if (absent.length) absent.forEach((a,i) => lines.push(`${i+1}. ${a}`));
  else lines.push('_None_');

  return lines.join('\n');
}

// --- Periodic boss timer checker (runs every second) ---
setInterval(() => {
  try {
    // check pending bosses: spawnISO <= now -> set active (if no active)
    const now = Date.now();
    if (!state.activeBoss) {
      const nextPending = state.bosses
        .filter(b => b.status === 'pending')
        .sort((a,b) => new Date(a.spawnISO) - new Date(b.spawnISO))[0];
      if (nextPending && new Date(nextPending.spawnISO).getTime() <= now) {
        // set active
        nextPending.status = 'active';
        state.activeBoss = nextPending.id;
        saveState();
        io.emit('data_update', state);
      }
    }

    // update remaining time for clients every tick
    io.emit('tick', { now });
  } catch (e) {
    console.error('timer tick err', e);
  }
}, 1000);

// --- Socket.IO to push changes to clients ---
io.on('connection', (socket) => {
  console.log('Client connected', socket.id);
  socket.emit('init', { state, voice: Object.values(state.voiceLog) });

  socket.on('set_active_by_id', (id) => {
    const boss = state.bosses.find(b => b.id === id);
    if (boss) {
      // clear previous active
      if (state.activeBoss) {
        const prev = state.bosses.find(b => b.id === state.activeBoss);
        if (prev) prev.status = 'done';
      }
      boss.status = 'active';
      state.activeBoss = boss.id;
      saveState();
      io.emit('data_update', state);
    }
  });

  socket.on('force_next', () => {
    // mark current done and move to next pending
    if (state.activeBoss) {
      const cur = state.bosses.find(b => b.id === state.activeBoss);
      if (cur) cur.status = 'done';
      state.activeBoss = null;
    }
    const next = state.bosses.find(b => b.status === 'pending');
    if (next) {
      next.status = 'active';
      state.activeBoss = next.id;
    }
    saveState();
    io.emit('data_update', state);
  });

  socket.on('request_state', () => socket.emit('data_update', state));
});

// --- API endpoints ---

// GET state
app.get('/api/state', (req, res) => res.json({ ok: true, state }));

// Upload boss list (text or image). Parses names and times, creates boss entries
app.post('/api/upload-boss-list', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'file required' });
    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    let text = '';

    if (ext === '.txt' || ext === '.csv') {
      text = fs.readFileSync(filePath, 'utf8');
    } else {
      // image -> OCR
      const { data: { text: ocrText } } = await Tesseract.recognize(filePath, 'eng');
      text = ocrText;
    }

    // Basic parsing: expect lines like "BossName - 2025-11-04 14:30" or "BossName 14:30"
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    const parsed = [];
    for (const l of lines) {
      // attempt to capture a date/time in this line
      // regex to find ISO date/time or dd/mm/yyyy or mm/dd or hh:mm
      const dateIsoMatch = l.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}T\d{1,2}:\d{2}/);
      const dateMatch = l.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}/);
      const timeOnly = l.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);

      let name = l;
      let spawnISO = null;

      if (dateIsoMatch) {
        spawnISO = new Date(dateIsoMatch[0]).toISOString();
        name = l.replace(dateIsoMatch[0], '').replace(/[-–—:]/g, '').trim();
      } else if (dateMatch) {
        spawnISO = new Date(dateMatch[0]).toISOString();
        name = l.replace(dateMatch[0], '').trim();
      } else if (timeOnly) {
        // use today's date with that time (local)
        const [hh, mm] = timeOnly[0].split(':').map(Number);
        const d = new Date();
        d.setHours(hh, mm, 0, 0);
        spawnISO = d.toISOString();
        name = l.replace(timeOnly[0], '').trim();
      } else {
        // no time found: skip or push as pending with far future
        // set spawn to now + N minutes increment (next slots)
        const d = new Date(Date.now() + 60 * 60 * 1000); // default +1h
        spawnISO = d.toISOString();
      }

      name = name.replace(/[-:—–]/g, '').trim();
      if (!name) name = 'Unknown Boss';

      parsed.push({ name, spawnISO });
    }

    // Insert into state.bosses with ids and pending status
    parsed.forEach(p => {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
      state.bosses.push({ id, name: p.name, spawnISO: p.spawnISO, status: 'pending' });
    });

    saveState();
    io.emit('data_update', state);
    return res.json({ ok: true, parsed: parsed.length, parsedList: parsed });
  } catch (err) {
    console.error('upload-boss-list err', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Upload attendance image -> OCR -> save names & file
app.post('/api/upload-attendance', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'image required' });
    const filePath = req.file.path;
    const { data: { text } } = await Tesseract.recognize(filePath, 'eng');
    // split text lines and attempt to clean names
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const detected = lines.map(l => l.replace(/[^0-9A-Za-z_\- ]/g,'').trim()).filter(Boolean);
    const unique = Array.from(new Set(detected));

    const rec = { id: Date.now().toString(), file: path.basename(filePath), detected: unique, uploadedAt: Date.now() };
    state.attendanceRecords.unshift(rec);
    saveState();

    io.emit('upload_done', rec);
    return res.json({ ok: true, record: rec });
  } catch (err) {
    console.error('upload-attendance err', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Expose uploads for preview
app.use('/uploads', express.static(UPLOAD_DIR));

// Endpoint to get voice members quickly (derived from state.voiceLog)
app.get('/api/voice-members', (req, res) => {
  res.json({ ok: true, members: Object.values(state.voiceLog) });
});

// Endpoint to push update to Discord webhook (server-side)
app.post('/api/update-discord', async (req, res) => {
  try {
    // Build summary from current active boss, latest attendance, and voiceLog
    const activeBossObj = state.bosses.find(b => b.id === state.activeBoss) || null;
    const latestAttendance = (state.attendanceRecords && state.attendanceRecords[0]) ? state.attendanceRecords[0].detected : [];
    const voiceMap = state.voiceLog;

    const content = buildDiscordMessage(activeBossObj, latestAttendance, voiceMap);

    if (!DISCORD_WEBHOOK_URL) return res.status(400).json({ ok: false, error: 'DISCORD_WEBHOOK_URL not configured' });

    // POST to webhook using global fetch (Node 18+)
    const r = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (!r.ok) {
      const text = await r.text();
      console.error('Webhook failed', r.status, text);
      return res.status(500).json({ ok: false, error: 'webhook failed', status: r.status, text });
    }

    // After push: mark current active as done and advance to next pending
    if (state.activeBoss) {
      const cur = state.bosses.find(b => b.id === state.activeBoss);
      if (cur) cur.status = 'done';
      state.activeBoss = null;
    }
    // optionally remove latest attendance record (per your request, reset for next push)
    state.attendanceRecords = [];

    // set next pending as active (if any)
    const next = state.bosses.find(b => b.status === 'pending');
    if (next) {
      next.status = 'active';
      state.activeBoss = next.id;
    }

    state.lastSummary = { content, pushedAt: Date.now() };
    saveState();
    io.emit('data_update', state);
    io.emit('discord_pushed', { ok: true });

    return res.json({ ok: true });
  } catch (err) {
    console.error('update-discord err', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// helpful admin endpoints
app.post('/api/clear-records', (req, res) => {
  state.attendanceRecords = [];
  saveState();
  io.emit('data_update', state);
  return res.json({ ok: true });
});

app.post('/api/clear-bosses', (req, res) => {
  state.bosses = [];
  state.activeBoss = null;
  saveState();
  io.emit('data_update', state);
  return res.json({ ok: true });
});

// fallback
app.get('/ping', (req, res) => res.json({ ok: true, now: Date.now() }));

// --- Start server ---
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// --- Save on exit ---
process.on('SIGINT', () => { saveState(); process.exit(); });
process.on('SIGTERM', () => { saveState(); process.exit(); });
