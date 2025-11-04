// index.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.ensureDirSync(UPLOAD_DIR);

// load or initialize data
let data = { bosses: [], activeBoss: null, attendanceRecords: [] };
if (fs.existsSync(DATA_FILE)) {
  try { data = fs.readJSONSync(DATA_FILE); } catch(e){ console.error('read data error', e); }
}

// helper to save
function saveData() { fs.writeJSONSync(DATA_FILE, data, { spaces: 2 }); }

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---------- Discord bot setup ----------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const GUILD_ID = process.env.GUILD_ID || '';
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID || '';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

let activeVoiceState = {}; // userId -> { username, joinedAt, voiceChannelId, lastSeen }

async function initDiscord() {
  if (!DISCORD_TOKEN) {
    console.warn('No DISCORD_TOKEN provided. Discord features will be disabled.');
    return;
  }
  try {
    await discordClient.login(DISCORD_TOKEN);
    console.log('Discord client logged in');
  } catch (e) {
    console.error('Discord login error:', e);
  }

  // initial populate
  discordClient.on('ready', async () => {
    console.log('Discord ready:', discordClient.user?.tag);
    if (VOICE_CHANNEL_ID) {
      try {
        const ch = await discordClient.channels.fetch(VOICE_CHANNEL_ID);
        if (ch && ch.members) {
          ch.members.forEach(m => {
            if (!m.user.bot) {
              activeVoiceState[m.id] = {
                id: m.id,
                username: m.user.username,
                displayName: m.displayName || m.user.username,
                joinedAt: Date.now(),
                lastSeen: Date.now(),
                voiceChannelId: VOICE_CHANNEL_ID
              };
            }
          });
          io.emit('voice_update', Object.values(activeVoiceState));
        }
      } catch (err) {
        console.warn('Could not fetch voice channel members:', err.message);
      }
    }
  });

  discordClient.on('voiceStateUpdate', (oldState, newState) => {
    // track joins/leaves in the specified voice channel
    const user = newState.member?.user || oldState.member?.user;
    if (!user || user.bot) return;
    const uid = user.id;

    const wasIn = oldState.channelId === VOICE_CHANNEL_ID;
    const nowIn = newState.channelId === VOICE_CHANNEL_ID;
    if (!wasIn && nowIn) {
      // joined
      activeVoiceState[uid] = {
        id: uid,
        username: user.username,
        displayName: newState.member.displayName || user.username,
        joinedAt: Date.now(),
        lastSeen: Date.now(),
        voiceChannelId: VOICE_CHANNEL_ID
      };
    } else if (wasIn && !nowIn) {
      // left
      delete activeVoiceState[uid];
    } else if (nowIn) {
      // still present - update lastSeen
      if (activeVoiceState[uid]) activeVoiceState[uid].lastSeen = Date.now();
    }
    io.emit('voice_update', Object.values(activeVoiceState));
  });

  // update presence/name changes
  discordClient.on('presenceUpdate', (oldP, newP) => {
    const user = newP.user;
    if (!user) return;
    const uid = user.id;
    if (activeVoiceState[uid]) {
      activeVoiceState[uid].username = user.username;
      io.emit('voice_update', Object.values(activeVoiceState));
    }
  });
}

initDiscord();

// ---------- Socket.IO realtime ----------
io.on('connection', socket => {
  // send current data
  socket.emit('init', { data, voice: Object.values(activeVoiceState) });

  socket.on('create_boss', boss => {
    // boss: { name, spawnDateISO }
    const id = Date.now().toString();
    data.bosses.push({ id, ...boss });
    saveData();
    io.emit('data_update', data);
  });

  socket.on('delete_boss', id => {
    data.bosses = data.bosses.filter(b => b.id !== id);
    saveData();
    io.emit('data_update', data);
  });

  socket.on('set_active', active => {
    data.activeBoss = active; // { id, name, spawnDateISO }
    saveData();
    io.emit('data_update', data);
  });

  socket.on('update_to_discord', async payload => {
    // payload: { activeBoss, attendance: [ {username, durationSec, matchedNames: [] } ] }
    if (!DISCORD_WEBHOOK_URL) {
      socket.emit('discord_error', 'No webhook configured on server.');
      return;
    }
    const content = buildDiscordContent(payload);
    try {
      const r = await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      // after pushing, clear active boss
      data.activeBoss = null;
      saveData();
      io.emit('data_update', data);
      socket.emit('discord_ok', 'Updated to Discord webhook.');
    } catch (err) {
      socket.emit('discord_error', `Webhook error: ${err.message}`);
    }
  });
});

function buildDiscordContent(payload) {
  const bossName = payload.activeBoss?.name || 'Unknown Boss';
  const date = new Date().toLocaleString();
  let txt = `**Boss Attendance — ${bossName}**\nDate: ${date}\n\n`;
  if (payload.attendance && payload.attendance.length) {
    payload.attendance.forEach((a, i) => {
      txt += `${i+1}. ${a.username} — ${formatSec(a.durationSec)}`;
      if (a.matchedNames && a.matchedNames.length) txt += ` (matches: ${a.matchedNames.join(', ')})`;
      txt += `\n`;
    });
  } else txt += '_No attendees detected_\n';
  return txt;
}

function formatSec(s) {
  const h = Math.floor(s/3600); s%=3600;
  const m = Math.floor(s/60); const sec = s%60;
  return (h? h+'h ':'') + (m? m+'m ':'') + sec+'s';
}

// ---------- OCR upload endpoint ----------
const upload = multer({ dest: UPLOAD_DIR });
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    const filePath = req.file.path;
    // run Tesseract
    const { data: { text } } = await Tesseract.recognize(filePath, 'eng', { logger: m => {/* progress */} });
    // basic lines -> names
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    // naive clean: remove short words and non-letters
    const candidates = lines.map(l => l.replace(/[^0-9A-Za-z_\- ]/g,'').trim()).filter(l => l.length >= 2);
    // return unique
    const unique = Array.from(new Set(candidates));
    // save record of upload
    const rec = { id: Date.now().toString(), file: path.basename(filePath), detected: unique, uploadedAt: Date.now() };
    data.attendanceRecords = data.attendanceRecords || [];
    data.attendanceRecords.unshift(rec);
    saveData();
    io.emit('upload_done', rec);
    res.json({ ok: true, detected: unique, record: rec });
  } catch (err) {
    console.error('OCR error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});

// ---------- API for boss data ----------
app.get('/api/data', (req, res) => res.json({ data }));
app.post('/api/bosses', (req, res) => {
  const boss = req.body;
  boss.id = Date.now().toString();
  data.bosses.push(boss);
  saveData();
  io.emit('data_update', data);
  res.json({ ok:true, boss });
});
app.delete('/api/bosses/:id', (req, res) => {
  data.bosses = data.bosses.filter(b => b.id !== req.params.id);
  saveData();
  io.emit('data_update', data);
  res.json({ ok:true });
});

// serve uploaded images for preview
app.use('/uploads', express.static(UPLOAD_DIR));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
