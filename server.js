import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs-extra";
import multer from "multer";
import dotenv from "dotenv";
import { Client, GatewayIntentBits } from "discord.js";
import fetch from "node-fetch";
import Tesseract from "tesseract.js";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(cors());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });
const DATA_FILE = "./data/attendance.json";

await fs.ensureFile(DATA_FILE);
if (!(await fs.readFile(DATA_FILE, "utf8"))) await fs.writeFile(DATA_FILE, "[]");

let pastAttendance = [];
let activeVoice = new Map();
let lastUploadedImage = null;
let detectedNames = [];

// Load saved data
fs.readJson(DATA_FILE)
  .then(data => (pastAttendance = data))
  .catch(() => (pastAttendance = []));

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
  const channel = await guild.channels.fetch(process.env.DISCORD_VOICE_CHANNEL_ID);
  if (channel && channel.members) {
    channel.members.forEach(member => {
      const name = member.displayName || member.user.username;
      activeVoice.set(member.id, { id: member.id, name, joinTime: Date.now() });
    });
  }

  sendUpdate();
});

client.on("voiceStateUpdate", (oldState, newState) => {
  const channelId = process.env.DISCORD_VOICE_CHANNEL_ID;

  // joined
  if (newState.channelId === channelId && oldState.channelId !== channelId) {
    const member = newState.member;
    const nickname = member.displayName || member.user.username;
    activeVoice.set(newState.id, { id: newState.id, name: nickname, joinTime: Date.now() });
  }

  // left
  if (oldState.channelId === channelId && newState.channelId !== channelId) {
    const member = activeVoice.get(oldState.id);
    if (member) {
      member.leaveTime = Date.now();
      member.duration = Math.round((member.leaveTime - member.joinTime) / 1000);
      pastAttendance.push(member);
      activeVoice.delete(oldState.id);
      fs.writeJson(DATA_FILE, pastAttendance);
    }
  }

  sendUpdate();
});

function sendUpdate() {
  const active = Array.from(activeVoice.values()).map(m => ({
    ...m,
    duration: Math.round((Date.now() - m.joinTime) / 1000),
  }));
  io.emit("update-attendance", { active, past: pastAttendance.slice(-30), image: lastUploadedImage, detected: detectedNames });
}

app.post("/upload", upload.single("image"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send("No image");

  lastUploadedImage = `/uploads/${file.filename}`;
  detectedNames = [];

  // OCR
  const { data } = await Tesseract.recognize(file.path, "eng");
  const lines = data.text.split("\n").map(l => l.trim()).filter(l => l);
  detectedNames = lines;

  sendUpdate();
  res.json({ success: true, image: lastUploadedImage, names: detectedNames });
});

app.get("/push-discord", async (req, res) => {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  const boss = req.query.boss || "Unknown Boss";

  const active = Array.from(activeVoice.values()).map(m => ({
    ...m,
    duration: Math.round((Date.now() - m.joinTime) / 1000),
  }));

  const report = active.map(m => {
    const minutes = Math.floor(m.duration / 60);
    const seconds = m.duration % 60;
    const present = detectedNames.includes(m.name) ? "Present" : "Absent";
    return `${m.name} — ${minutes}m ${seconds}s — ${boss} — ${present}`;
  }).join("\n");

  const message = {
    content: `🎧 **Boss Attendance Report**\n**Boss:** ${boss}\n-----------------\n${report || "_No active members._"}`,
  };

  const webhookData = new FormData();
  webhookData.append("payload_json", JSON.stringify(message));

  if (lastUploadedImage) {
    const fileData = await fs.readFile(`.${lastUploadedImage}`);
    webhookData.append("file", fileData, "attendance.png");
  }

  await fetch(webhook, { method: "POST", body: webhookData });

  await fs.writeJson(DATA_FILE, pastAttendance);
  res.send("ok");
});

app.use("/uploads", express.static("uploads"));

client.login(process.env.DISCORD_BOT_TOKEN);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
