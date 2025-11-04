import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs-extra";
import dotenv from "dotenv";
import path from "path";
import multer from "multer";
import Tesseract from "tesseract.js";
import fetch from "node-fetch";
import FormData from "form-data";
import { Client, GatewayIntentBits } from "discord.js";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(cors());
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

// ─── Setup ───
const DATA_FILE = "./data/attendance.json";
await fs.ensureFile(DATA_FILE);
if (!(await fs.readFile(DATA_FILE, "utf8"))) await fs.writeFile(DATA_FILE, "[]");

// ─── Discord Bot ───
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let voiceMembers = new Map();
let pastAttendance = [];
let uploadedImages = []; // keep list of uploaded image file paths

// Load old attendance
fs.readJson(DATA_FILE)
  .then((data) => (pastAttendance = data))
  .catch(() => (pastAttendance = []));

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  io.emit("bot-status", { connected: true, name: client.user.tag });
});

// ─── Voice Channel Tracking ───
client.on("voiceStateUpdate", async (oldState, newState) => {
  const channelId = process.env.DISCORD_VOICE_CHANNEL_ID;

  // joined
  if (newState.channelId === channelId && oldState.channelId !== channelId) {
    const member = newState.member;
    const nickname = member.displayName || member.user.username;

    voiceMembers.set(newState.id, {
      id: newState.id,
      name: nickname,
      joinTime: Date.now(),
    });
  }

  // left
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

function sendUpdate() {
  const active = Array.from(voiceMembers.values()).map((m) => ({
    ...m,
    duration: Math.round((Date.now() - m.joinTime) / 1000),
  }));
  io.emit("update-attendance", { active, past: pastAttendance.slice(-20) });
}

// ─── Upload + OCR ───
const upload = multer({ dest: "uploads/" });

app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const imagePath = path.resolve(req.file.path);
    uploadedImages.push(imagePath);
    console.log("🖼️ OCR processing:", imagePath);

    const result = await Tesseract.recognize(imagePath, "eng+chi_sim", {
      logger: (m) => {
        if (m.status === "recognizing text") console.log(`Progress: ${(m.progress * 100).toFixed(1)}%`);
      },
    });

    const text = result.data.text;
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    console.log("✅ OCR detected:", lines);

    // Emit result to front-end immediately
    io.emit("ocr-result", { names: lines, imagePath: `/uploads/${path.basename(imagePath)}` });

    res.json({ names: lines, imagePath: `/uploads/${path.basename(imagePath)}` });
  } catch (err) {
    console.error("❌ OCR Error:", err);
    io.emit("ocr-result", { error: true });
    res.status(500).json({ error: "OCR failed" });
  }
});

// ─── Push to Discord ───
app.get("/push-discord", async (req, res) => {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  const boss = req.query.boss || "Unknown Boss";

  const active = Array.from(voiceMembers.values()).map((m) => ({
    name: m.name,
    duration: Math.round((Date.now() - m.joinTime) / 1000),
  }));

  const report = active
    .map((m) => {
      const minutes = Math.floor(m.duration / 60);
      const seconds = m.duration % 60;
      return `${m.name} — ${minutes}m ${seconds}s — ${boss} — Present ✅`;
    })
    .join("\n");

  const content =
    `🎧 **Boss Attendance Report**\n` +
    `**Boss:** ${boss}\n-----------------\n` +
    `${report || "_No active members detected._"}`;

  const formData = new FormData();
  const body = { content };

  // attach all uploaded images
  uploadedImages.forEach((imgPath, i) => {
    formData.append(`files[${i}]`, fs.createReadStream(imgPath), path.basename(imgPath));
  });

  formData.append("payload_json", JSON.stringify(body));

  await fetch(webhook, { method: "POST", body: formData });
  console.log("✅ Attendance pushed to Discord");

  uploadedImages = []; // reset after push
  res.send("ok");
});

// ─── Auto-sync on startup ───
client.on("ready", async () => {
  const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
  const channel = await guild.channels.fetch(process.env.DISCORD_VOICE_CHANNEL_ID);
  if (channel && channel.isVoiceBased()) {
    for (const [id, member] of channel.members) {
      voiceMembers.set(id, {
        id,
        name: member.displayName || member.user.username,
        joinTime: Date.now(),
      });
    }
    sendUpdate();
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
