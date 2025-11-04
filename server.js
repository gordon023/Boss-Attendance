// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs-extra";
import dotenv from "dotenv";
import multer from "multer";
import Tesseract from "tesseract.js";
import { Client, GatewayIntentBits } from "discord.js";
import fetch from "node-fetch";
import FormData from "form-data";
import path from "path";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const DATA_DIR = "./data";
const DATA_FILE = `${DATA_DIR}/attendance.json`;
await fs.ensureDir(DATA_DIR);
await fs.ensureFile(DATA_FILE);
if (!(await fs.readFile(DATA_FILE, "utf8"))) await fs.writeFile(DATA_FILE, "[]");

// Multer setup for uploads
const upload = multer({ dest: "uploads/" });
await fs.ensureDir("./uploads");

// state
let pastAttendance = [];
let activeVoice = new Map(); // id -> { id, name, joinTime }
let lastUploaded = null;     // { path, filename, url } (url served at /uploads/...)
let lastDetectedNames = [];  // OCR names array

// load saved past attendance
try {
  pastAttendance = await fs.readJson(DATA_FILE);
} catch (err) {
  pastAttendance = [];
}

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// helper to emit updates
function emitUpdate() {
  const active = Array.from(activeVoice.values()).map(m => ({
    ...m,
    duration: Math.round((Date.now() - m.joinTime) / 1000),
  }));
  io.emit("update-attendance", {
    active,
    past: pastAttendance.slice(-30),
    image: lastUploaded ? `/uploads/${lastUploaded.filename}` : null,
    detected: lastDetectedNames,
  });
}

// when bot ready: fetch guild / channel members currently in VC
client.once("ready", async () => {
  console.log("✅ Discord bot ready:", client.user.tag);
  io.emit("bot-status", { connected: true, name: client.user.tag });

  try {
    if (process.env.DISCORD_GUILD_ID && process.env.DISCORD_VOICE_CHANNEL_ID) {
      const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID).catch(()=>null);
      if (guild) {
        const channel = await guild.channels.fetch(process.env.DISCORD_VOICE_CHANNEL_ID).catch(()=>null);
        if (channel && channel.members) {
          // populate activeVoice with current members; joinTime set to now (can't retrieve original join timestamps)
          for (const [id, member] of channel.members) {
            const nickname = member.displayName || member.user.username;
            activeVoice.set(id, { id, name: nickname, joinTime: Date.now() });
          }
        }
      }
    }
  } catch (e) {
    console.warn("Error fetching initial channel members:", e.message || e);
  }

  emitUpdate();
});

// track join/leave
client.on("voiceStateUpdate", (oldState, newState) => {
  const channelId = process.env.DISCORD_VOICE_CHANNEL_ID;

  // join
  if (newState.channelId === channelId && oldState.channelId !== channelId) {
    const member = newState.member;
    const nickname = (member && member.displayName) ? member.displayName : (member ? member.user.username : "Unknown");
    activeVoice.set(newState.id, { id: newState.id, name: nickname, joinTime: Date.now() });
  }

  // leave
  if (oldState.channelId === channelId && newState.channelId !== channelId) {
    const m = activeVoice.get(oldState.id);
    if (m) {
      m.leaveTime = Date.now();
      m.duration = Math.round((m.leaveTime - m.joinTime) / 1000);
      pastAttendance.push(m);
      activeVoice.delete(oldState.id);
      fs.writeJson(DATA_FILE, pastAttendance).catch(err => console.error("writeJson err", err));
    }
  }

  emitUpdate();
});

// Upload endpoint: OCR (supports English + Chinese simplified)
app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const filepath = req.file.path;
    const filename = req.file.filename;
    lastUploaded = { path: filepath, filename };

    // Try eng+chi_sim first
    let lang = "eng+chi_sim";
    let text = "";
    try {
      const { data } = await Tesseract.recognize(filepath, lang, { logger: m => {/* silent */} });
      text = data.text || "";
    } catch (e) {
      // fallback to english only
      try {
        const { data } = await Tesseract.recognize(filepath, "eng", { logger: m => {/* silent */} });
        text = data.text || "";
      } catch (err) {
        console.error("OCR failed:", err);
        text = "";
      }
    }

    // split into lines and clean
    const lines = (text || "")
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0);

    lastDetectedNames = lines;

    // Serve file under /uploads/<filename> (static folder set below)
    emitUpdate();
    res.json({ image: `/uploads/${filename}`, names: lines });
  } catch (err) {
    console.error("upload err", err);
    res.status(500).json({ error: "ocr failed" });
  }
});

// Serve uploads
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// Push to Discord: sends only active members (current VC), includes uploaded image if exists
app.post("/push-discord", express.json(), async (req, res) => {
  try {
    const boss = req.body.boss || req.query.boss || "Unknown Boss";
    const webhook = process.env.DISCORD_WEBHOOK_URL;
    if (!webhook) return res.status(400).json({ error: "webhook not configured" });

    // prepare active members snapshot
    const active = Array.from(activeVoice.values()).map(m => ({
      ...m,
      duration: Math.round((Date.now() - m.joinTime) / 1000),
    }));

    // Build lines and check present/absent using lastDetectedNames (OCR)
    const norm = s => (s || "").toString().toLowerCase().replace(/\s+/g, "");
    const detectedNorm = lastDetectedNames.map(n => norm(n));
    const lines = active.map(m => {
      const minutes = Math.floor(m.duration / 60);
      const seconds = m.duration % 60;
      const present = detectedNorm.some(dn => dn && norm(m.name).includes(dn) || dn.includes(norm(m.name)));
      return `${m.name} — ${minutes}m ${seconds}s — ${boss} — ${present ? "Present" : "Absent"}`;
    });

    const content = `🎧 **Boss Attendance Report**\n**Boss:** ${boss}\n-----------------\n${lines.length ? lines.join("\n") : "_No active members currently._"}`;

    // Use form-data to send payload_json and optional file
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ content }));

    if (lastUploaded && lastUploaded.path) {
      // attach uploaded image
      const fileBuffer = await fs.readFile(lastUploaded.path);
      form.append("file", fileBuffer, { filename: "attendance.png" });
    }

    // send to webhook
    const response = await fetch(webhook, { method: "POST", body: form });
    if (!response.ok) {
      const txt = await response.text().catch(() => "");
      console.error("webhook failed", response.status, txt);
      return res.status(500).json({ error: "webhook failed", status: response.status });
    }

    // after push, optionally clear lastUploaded and lastDetectedNames if you want:
    // lastUploaded = null; lastDetectedNames = [];
    // but we will keep them to show preview until user clears

    return res.json({ ok: true });
  } catch (err) {
    console.error("push-discord err", err);
    return res.status(500).json({ error: "push failed" });
  }
});

// Socket connection - client may request state
io.on("connection", (socket) => {
  console.log("client connected:", socket.id);
  // emit initial state
  emitUpdate();
  socket.on("request_state", () => emitUpdate());
});

// login Discord
client.login(process.env.DISCORD_BOT_TOKEN).catch(err => {
  console.error("discord login failed:", err.message || err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
