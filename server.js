import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs-extra";
import dotenv from "dotenv";
import { Client, GatewayIntentBits } from "discord.js";
import fetch from "node-fetch";
import multer from "multer";
import Tesseract from "tesseract.js";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(cors());
app.use(express.static("public"));

// Upload config
const upload = multer({ dest: "uploads/" });

// === Load data ===
const DATA_FILE = "./data/attendance.json";
await fs.ensureFile(DATA_FILE);
if (!(await fs.readFile(DATA_FILE, "utf8"))) await fs.writeFile(DATA_FILE, "[]");
let pastAttendance = await fs.readJson(DATA_FILE).catch(() => []);

// === Discord Client ===
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let voiceMembers = new Map(); // id → { name, joinTime }

// --- When bot starts ---
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  io.emit("bot-status", { connected: true, name: client.user.tag });

  const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
  const channel = await guild.channels.fetch(process.env.DISCORD_VOICE_CHANNEL_ID);
  if (channel && channel.isVoiceBased()) {
    for (const [memberId, member] of channel.members) {
      voiceMembers.set(memberId, {
        id: memberId,
        name: member.displayName || member.user.username,
        joinTime: Date.now(),
      });
    }
    sendUpdate();
  }
});

// --- Track join/leave ---
client.on("voiceStateUpdate", (oldState, newState) => {
  const voiceChannelId = process.env.DISCORD_VOICE_CHANNEL_ID;

  // Join
  if (newState.channelId === voiceChannelId && oldState.channelId !== voiceChannelId) {
    const member = newState.member;
    voiceMembers.set(member.id, {
      id: member.id,
      name: member.displayName || member.user.username,
      joinTime: Date.now(),
    });
  }

  // Leave
  if (oldState.channelId === voiceChannelId && newState.channelId !== voiceChannelId) {
    const member = voiceMembers.get(oldState.id);
    if (member) {
      member.leaveTime = Date.now();
      member.duration = Math.round((member.leaveTime - member.joinTime) / 1000);
      pastAttendance.push(member);
      voiceMembers.delete(oldState.id);
      fs.writeJson(DATA_FILE, pastAttendance);
    }
  }

  sendUpdate();
});

function sendUpdate() {
  const active = Array.from(voiceMembers.values()).map((m) => ({
    ...m,
    duration: Math.round((Date.now() - m.joinTime) / 1000),
  }));

  io.emit("update-attendance", {
    active,
    past: pastAttendance.slice(-20),
  });
}

// === Upload OCR ===
app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    const imagePath = req.file.path;
    const result = await Tesseract.recognize(imagePath, "eng");
    const text = result.data.text;
    const names = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    res.json({ names });
    await fs.remove(imagePath);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "OCR failed" });
  }
});

// === Push to Discord ===
app.get("/push-discord", async (req, res) => {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  const boss = req.query.boss || "Unknown Boss";

  const report = Array.from(voiceMembers.values())
    .map((m) => {
      const minutes = Math.floor((Date.now() - m.joinTime) / 60000);
      const seconds = Math.floor(((Date.now() - m.joinTime) % 60000) / 1000);
      return `${m.name} — ${minutes}m ${seconds}s — ${boss} — Present ✅`;
    })
    .join("\n");

  const message = {
    content: `🎧 **Boss Attendance Report**\n**Boss:** ${boss}\n-----------------\n${report || "_No active members detected._"}`,
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
