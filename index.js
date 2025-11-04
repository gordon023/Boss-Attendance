import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import multer from 'multer';
import fs from 'fs-extra';
import cors from 'cors';
import fetch from 'node-fetch';
import Tesseract from 'tesseract.js';
import { Client, GatewayIntentBits } from 'discord.js';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.static('public'));
app.use(express.json());
fs.ensureDirSync('./uploads');
fs.ensureDirSync('./data');

// === Discord bot for voice detection ===
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});
client.login(process.env.DISCORD_BOT_TOKEN);
client.once('ready', () => console.log(`🤖 Logged in as ${client.user.tag}`));

// === File upload setup ===
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './uploads'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// === OCR detection route ===
app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    const { path } = req.file;
    const { data: { text } } = await Tesseract.recognize(path, 'eng');
    console.log('📸 OCR text:', text);
    res.json({ success: true, text });
  } catch (err) {
    console.error('OCR error:', err);
    res.status(500).json({ error: 'OCR failed' });
  }
});

// === Discord webhook update ===
async function sendToDiscord(content) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return console.error('⚠️ Missing webhook URL');
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
}

// === Socket.io live sync ===
let bosses = [];

io.on('connection', (socket) => {
  console.log('🟢 User connected');
  socket.emit('update', bosses);

  socket.on('addBoss', (data) => {
    bosses.push(data);
    io.emit('update', bosses);
  });

  socket.on('updateToDiscord', async (msg) => {
    await sendToDiscord(msg);
    bosses = []; // clear active boss list after posting
    io.emit('update', bosses);
  });
});

// === Voice detection function ===
async function getVoiceMembers(guildId, channelId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return [];
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isVoiceBased()) return [];
  return Array.from(channel.members.values()).map(m => m.user.username);
}

app.get('/voice/:guildId/:channelId', async (req, res) => {
  const members = await getVoiceMembers(req.params.guildId, req.params.channelId);
  res.json({ members });
});

// === Start server ===
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
