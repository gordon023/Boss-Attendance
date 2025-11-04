import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import multer from "multer";
import fs from "fs-extra";
import path from "path";
import Tesseract from "tesseract.js";

const app = express();
const server = createServer(app);
const io = new Server(server);
const PORT = 10000; // Render hard-coded port

app.use(express.json());
app.use(express.static("public"));
app.use("/data", express.static("data"));
fs.ensureDirSync("uploads");
fs.ensureDirSync("data");

const bossDataPath = "./data/bossData.json";
if (!fs.existsSync(bossDataPath)) fs.writeJSONSync(bossDataPath, []);

const upload = multer({ dest: "uploads/" });

// --- OCR handler ---
app.post("/upload-ocr", upload.single("file"), async (req, res) => {
  try {
    const { path: filePath } = req.file;
    const { data: { text } } = await Tesseract.recognize(filePath, "eng");
    res.json({ success: true, text });
    io.emit("ocr-result", text);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Boss list upload (image/text) ---
app.post("/upload-bosslist", upload.single("file"), async (req, res) => {
  try {
    const { path: filePath } = req.file;
    const { data: { text } } = await Tesseract.recognize(filePath, "eng");
    const lines = text.split("\n").filter(l => l.trim());
    const bossEntries = lines.map(line => ({ name: line, time: Date.now() }));
    await fs.writeJSON(bossDataPath, bossEntries);
    io.emit("boss-update", bossEntries);
    res.json({ success: true, bosses: bossEntries });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Placeholder for your Discord connection code ---
// ----------- DISCORD VOICE TRACKING WITH DURATION -----------
import { Client, GatewayIntentBits } from "discord.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// Keep in-memory session data
const voiceSessions = new Map(); // key: userId, value: { name, joinedAt, duration }

// Helper: recalc duration for each member
function calculateDurations(channel) {
  const now = Date.now();
  channel.members.forEach(member => {
    const id = member.user.id;
    if (!voiceSessions.has(id)) {
      voiceSessions.set(id, {
        name: member.user.username,
        joinedAt: now,
        duration: 0,
      });
    } else {
      const session = voiceSessions.get(id);
      session.duration = Math.floor((now - session.joinedAt) / 1000);
    }
  });
}

// Emit current table to all connected clients
function emitVoiceTable() {
  const data = Array.from(voiceSessions.values()).map(v => ({
    name: v.name,
    joinedAt: new Date(v.joinedAt).toLocaleTimeString(),
    duration: v.duration,
  }));
  io.emit("voice-update", data);
}

client.once("ready", () => {
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);
});

client.on("voiceStateUpdate", (oldState, newState) => {
  const channelId = process.env.DISCORD_VOICE_CHANNEL_ID;
  const targetChannel = client.channels.cache.get(channelId);
  if (!targetChannel || targetChannel.type !== 2) return; // Voice only

  // If user left the voice channel
  if (oldState.channelId === channelId && newState.channelId !== channelId) {
    const session = voiceSessions.get(newState.id);
    if (session) {
      session.duration = Math.floor((Date.now() - session.joinedAt) / 1000);
      session.leftAt = Date.now();
      console.log(`❌ ${session.name} left after ${session.duration}s`);
      // Optionally, write to JSON or move to history array here
      voiceSessions.delete(newState.id);
    }
  }

  // If user joined the voice channel
  if (newState.channelId === channelId && oldState.channelId !== channelId) {
    voiceSessions.set(newState.id, {
      name: newState.member.user.username,
      joinedAt: Date.now(),
      duration: 0,
    });
    console.log(`🎙️ ${newState.member.user.username} joined VC`);
  }

  // Recalculate and broadcast
  const channel = client.channels.cache.get(channelId);
  if (channel) calculateDurations(channel);
  emitVoiceTable();
});

// Periodic updates while users remain inside
setInterval(() => {
  const channelId = process.env.DISCORD_VOICE_CHANNEL_ID;
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;
  calculateDurations(channel);
  emitVoiceTable();
}, 5000);

client
  .login(process.env.DISCORD_BOT_TOKEN)
  .catch(err => console.error("Discord login error:", err));


// --- Realtime connections ---
io.on("connection", socket => {
  console.log("Client connected");
  socket.on("disconnect", () => console.log("Client disconnected"));
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ----------- DISCORD VOICE DETECTION -----------
import { Client, GatewayIntentBits } from "discord.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// Listen for join/leave events
client.on("voiceStateUpdate", (oldState, newState) => {
  const channelId = process.env.DISCORD_VOICE_CHANNEL_ID;
  if (!channelId) return;

  const channel = client.channels.cache.get(channelId);
  if (!channel || channel.type !== 2) return; // 2 = Voice Channel type

  const members = [...channel.members.values()].map(m => ({
    id: m.user.id,
    name: m.user.username,
    joinedAt: m.voice?.sessionId ? Date.now() : null,
  }));

  io.emit("voice-update", members);
});

client.login(process.env.DISCORD_BOT_TOKEN).catch(err =>
  console.error("Discord login error:", err)
);

