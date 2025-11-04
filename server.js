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

const DATA_FILE = "./data/attendance.json";
await fs.ensureFile(DATA_FILE);
if (!(await fs.readFile(DATA_FILE, "utf8"))) await fs.writeFile(DATA_FILE, "[]");

// ─── Discord Bot ────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let voiceMembers = new Map();
let pastAttendance = [];
let uploadedImagePath = null;

// Load saved data
fs.readJson(DATA_FILE)
  .then((data) => (pastAttendance = data))
  .catch(() => (pastAttendance = []));

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  io.emit("bot-status", { connected: true, name: client.user.tag });
});

// ─── Voice Channel Tracking ─────────────────────
client.on("voiceStateUpdate", async (oldState, newState) => {
  const channelId = process.env.DISCORD_VOICE_CHANNEL_ID;

  // Member joined
  if (newState.channelId === channelId && oldState.channelId !== channelId) {
    const member = newState.member;
    const nickname = member.displayName || member.user.username;

    voiceMembers.set(newState.id, {
      id: newState.id,
      name: nickname,
      joinTime: Date.now(),
    });
  }

  // Member left
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

  io.emit("update-attendance", {
    active,
    past: pastAttendance.slice(-20),
  });
}

// ─── Upload + OCR (English + Chinese, merged names) ───────────
// ─── Upload + OCR (English + Chinese, smarter vertical detection) ───────────
// ─── Upload + OCR (English + Chinese, vertical box detection) ───────────
const upload = multer({ dest: "uploads/" });

app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const imagePath = path.resolve(req.file.path);
    uploadedImagePath = imagePath;
    console.log("🖼️ OCR received:", imagePath);

    // respond immediately
    res.json({ status: "processing", imagePath: `/uploads/${path.basename(imagePath)}` });

    // Run OCR in "sparse text" mode (PSM 11) for box-like rows
    Tesseract.recognize(imagePath, "chi_sim+eng", {
      tessedit_pageseg_mode: 11, // detect many small text boxes
      logger: (m) => console.log(m.status, m.progress),
    })
      .then((result) => {
        const raw = result.data.text || "";

        // Split on newlines and remove junk
        const lines = raw
          .split(/\r?\n/)
          .map((l) => l.replace(/\s+/g, "").trim())
          .filter((l) => l.length > 0 && !/^[xX\d\W]+$/.test(l));

        // Further break any long merged line like "JinshiNeslein" by
        // transition between lowercase→uppercase or Chinese↔English
        const names = [];
        for (let line of lines) {
          line = line
            .replace(/([a-z])([A-Z])/g, "$1|$2")
            .replace(/([A-Za-z]+)(?=[\u4e00-\u9fa5])/g, "$1|")
            .replace(/([\u4e00-\u9fa5]+)(?=[A-Za-z])/g, "$1|");
          for (const n of line.split("|")) {
            const name = n.trim();
            if (name.length > 1 && !/^[xX\d\W]+$/.test(name)) names.push(name);
          }
        }

        console.log("✅ OCR vertical names:", names);

        io.emit("ocr-result", {
          names,
          imagePath: `/uploads/${path.basename(imagePath)}`,
        });
      })
      .catch((err) => {
        console.error("❌ OCR error:", err);
        io.emit("ocr-result", { error: "OCR failed." });
      });
  } catch (err) {
    console.error("❌ Upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});


// Serve uploaded images
app.use("/uploads", express.static("uploads"));

// ─── Push to Discord ────────────────────────────
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

  const content = `🎧 **Boss Attendance Report**\n**Boss:** ${boss}\n-----------------\n${report || "_No active members detected._"}`;

  const body = uploadedImagePath
    ? {
        content,
        embeds: [
          {
            title: "Attendance Image",
            image: { url: `attachment://${path.basename(uploadedImagePath)}` },
          },
        ],
      }
    : { content };

  const formData = new FormData();
  formData.append("payload_json", JSON.stringify(body));

  if (uploadedImagePath) {
    const buffer = await fs.readFile(uploadedImagePath);
    formData.append("files[0]", buffer, path.basename(uploadedImagePath));
  }

  await fetch(webhook, {
    method: "POST",
    body: formData,
  });

  console.log("✅ Attendance pushed to Discord");
  res.send("ok");
});

// ─── Auto-sync active members on startup ────────
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
