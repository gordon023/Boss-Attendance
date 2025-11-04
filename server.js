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

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.static("public"));
app.use(express.json());

const DATA_FILE = "./data/attendance.json";
await fs.ensureFile(DATA_FILE);
if (!(await fs.readFile(DATA_FILE, "utf8"))) await fs.writeFile(DATA_FILE, "[]");

let voiceMembers = new Map();
let pastAttendance = [];

try {
  pastAttendance = await fs.readJson(DATA_FILE);
} catch {
  pastAttendance = [];
}

// --- Discord Bot ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once("clientReady", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  io.emit("bot-status", { connected: true, name: client.user.tag });
});

// Track voice activity
client.on("voiceStateUpdate", async (oldState, newState) => {
  const channelId = process.env.DISCORD_VOICE_CHANNEL_ID;

  if (newState.channelId === channelId && oldState.channelId !== channelId) {
    const nickname = newState.member.displayName || newState.member.user.username;
    voiceMembers.set(newState.id, { id: newState.id, name: nickname, joinTime: Date.now() });
  }

  if (oldState.channelId === channelId && newState.channelId !== channelId) {
    const member = voiceMembers.get(oldState.id);
    if (member) {
      member.leaveTime = Date.now();
      member.duration = Math.round((member.leaveTime - member.joinTime) / 1000);
      pastAttendance.push(member);
      voiceMembers.delete(oldState.id);
      await fs.writeJson(DATA_FILE, pastAttendance);
    }
  }

  sendUpdate();
});

// Send updates to dashboard
function sendUpdate() {
  const active = Array.from(voiceMembers.values()).map((m) => ({
    ...m,
    duration: Math.round((Date.now() - m.joinTime) / 1000),
  }));

  io.emit("update-attendance", { active, past: pastAttendance.slice(-20) });
}

// --- OCR Image Upload ---
const upload = multer({ dest: "uploads/" });

app.post("/upload", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).send("No image uploaded");

  try {
    const { data } = await Tesseract.recognize(req.file.path, "eng");
    const lines = data.text
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);

    res.json({ names: lines });
    fs.unlink(req.file.path); // cleanup temp file
  } catch (err) {
    console.error("OCR Error:", err);
    res.status(500).send("OCR failed");
  }
});

// --- Push Attendance to Discord ---
app.get("/push-discord", async (req, res) => {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  const boss = req.query.boss || "Unknown Boss";

  const activeList = Array.from(voiceMembers.values()).map((m) => {
    const minutes = Math.floor((Date.now() - m.joinTime) / 60000);
    const seconds = Math.floor(((Date.now() - m.joinTime) % 60000) / 1000);
    return `${m.name} — ${minutes}m ${seconds}s — ${boss} — Present`;
  });

  const report =
    activeList.length > 0
      ? activeList.join("\n")
      : "_No active members currently in VC._";

  const message = {
    content: `🎧 **Boss Attendance Report**\n**Boss:** ${boss}\n-----------------\n${report}`,
  };

  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });

  res.send("ok");
});

client.login(process.env.DISCORD_BOT_TOKEN);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
