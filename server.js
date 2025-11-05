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

// ✅ Ensure data file exists before use
await fs.ensureDir(path.dirname(DATA_FILE));
if (!(await fs.pathExists(DATA_FILE))) await fs.writeJson(DATA_FILE, []);

// ─── Registered Player Names ─────────────────────────────
const REGISTERED_NAMES = [
  "轻云","Jinshi","清源","pagog0mac","mecmec","TOUAREG","Yuisha","上帝之手",
  "Zhreytis","Own","LolaKerps","Cathaleah","Crysz","Rintaro","ForgeArt","XCKEL",
  "Aerokhart神","dShadow2","Tatangers","Pharit4","HHERMESS","Aluky","Daisukiii",
  "Zinoky","Inoyi","Fiekor","RhianEunice","Traelinastra","Jomz","Disturbed",
  "ArcherQueen","CCO","DivineAura","君主Axel","KenRich","Tikoy","Thalechoe",
  "SoulChillin","CROZZBOW","Bellanoir","Krii","yGG"
];

// ─── Discord Bot ────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let voiceMembers = new Map();
let pastAttendance = [];
let uploadedImagePath = null;
global.lastDetectedNames = [];

// Load saved data
try {
  pastAttendance = await fs.readJson(DATA_FILE);
} catch {
  pastAttendance = [];
}

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

// ─── Keep clients synced on connect ─────────────
io.on("connection", (socket) => {
  console.log("🖥️ Client connected");
  sendUpdate();

  if (uploadedImagePath) {
    socket.emit("ocr-result", {
      names: global.lastDetectedNames,
      matched: global.lastMatchedNames || [],
      imagePath: `/uploads/${path.basename(uploadedImagePath)}`,
    });
  }
});

// ─── Upload + OCR (English + Chinese, async worker) ───────────
const upload = multer({ dest: "uploads/" });

app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const imagePath = path.resolve(req.file.path);
    uploadedImagePath = imagePath;
    console.log("🖼️ OCR received:", imagePath);

    // Respond immediately so browser doesn't hang
    res.json({ status: "processing", imagePath: `/uploads/${path.basename(imagePath)}` });

    // Perform OCR asynchronously and emit results to client
    Tesseract.recognize(imagePath, "eng+chi_sim", {
      logger: (m) => console.log(m.status, m.progress),
    })
      .then((result) => {
        // 🔹 Extract boxes and clean text properly (per box detection)
        const boxes = result.data.words || [];
        const detectedNames = boxes
          .map((w) => w.text.trim())
          .filter((text) => {
            // remove random symbols / single junk
            if (!text) return false;
            if (/^[a-zA-Z]$/.test(text)) return false; // single english letter
            if (/^[\u4e00-\u9fa5]$/.test(text)) return false; // single chinese char
            if (/^[^a-zA-Z0-9\u4e00-\u9fa5]+$/.test(text)) return false; // pure symbols
            return true;
          })
          .map((text) => text.replace(/['"]/g, "")) // remove stray quotes
          .filter((t) => t.length > 1);

        // 🔹 Compare detected names with registered list
        const matched = REGISTERED_NAMES.map((name) => ({
          name,
          detected: detectedNames.some(
            (det) => det.toLowerCase() === name.toLowerCase()
          )
            ? "✅ Present"
            : "❌ Absent",
        }));

        global.lastDetectedNames = detectedNames;
        global.lastMatchedNames = matched;

        console.log("✅ OCR detected names:", detectedNames);
        console.log("📋 Matched list:", matched);

        io.emit("ocr-result", {
          names: detectedNames,
          matched,
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

  // 🔹 Combine OCR names and active voice members
  const ocrNames = global.lastDetectedNames || [];
  const combinedList = ocrNames.map((ocrName) => {
    const match = active.find(
      (v) => v.name.toLowerCase() === ocrName.toLowerCase()
    );
    return {
      imageName: ocrName,
      discordName: match ? match.name : "-",
      activeInDiscord: match ? "✅ Present" : "❌ Absent",
      bossHunt: match ? "✅ Present" : "❌ Absent",
    };
  });

  const combinedReport = combinedList
    .map(
      (c) =>
        `${c.imageName} | ${c.discordName} | ${c.activeInDiscord} | ${c.bossHunt}`
    )
    .join("\n");

  const content = `🎯 **Boss Attendance Report**\n-----------------\n${combinedReport}`;

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
