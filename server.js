import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs, { promises as fsp } from "fs";
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

// === Persistent data store ===
const DATA_FILE = "./data/attendance.json";

// ensure file exists
try {
  await fsp.access(DATA_FILE);
} catch {
  await fsp.mkdir("./data", { recursive: true });
  await fsp.writeFile(DATA_FILE, "[]");
}

// load attendance
let pastAttendance = [];
try {
  const content = await fsp.readFile(DATA_FILE, "utf8");
  pastAttendance = JSON.parse(content || "[]");
} catch {
  pastAttendance = [];
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let voiceMembers = new Map();
let uploadedImagePath = null;
global.lastDetectedNames = [];

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  io.emit("bot-status", { connected: true, name: client.user.tag });
});

// === Voice channel attendance tracking ===
client.on("voiceStateUpdate", async (oldState, newState) => {
  const channelId = process.env.DISCORD_VOICE_CHANNEL_ID;

  if (newState.channelId === channelId && oldState.channelId !== channelId) {
    const member = newState.member;
    const nickname = member.displayName || member.user.username;
    voiceMembers.set(newState.id, {
      id: newState.id,
      name: nickname,
      joinTime: Date.now(),
    });
  }

  if (oldState.channelId === channelId && newState.channelId !== channelId) {
    const member = voiceMembers.get(oldState.id);
    if (member) {
      member.leaveTime = Date.now();
      member.duration = Math.round((member.leaveTime - member.joinTime) / 1000);
      pastAttendance.push(member);
      voiceMembers.delete(oldState.id);
      await fsp.writeFile(DATA_FILE, JSON.stringify(pastAttendance, null, 2));
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

io.on("connection", (socket) => {
  console.log("🖥️ Client connected");
  sendUpdate();
  if (uploadedImagePath) {
    socket.emit("ocr-result", {
      names: global.lastDetectedNames,
      imagePath: `/uploads/${path.basename(uploadedImagePath)}`,
    });
  }
});

const upload = multer({ dest: "uploads/" });

// === OCR upload and processing ===
app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const imagePath = path.resolve(req.file.path);
    uploadedImagePath = imagePath;
    console.log("🖼️ OCR received:", imagePath);
    res.json({ status: "processing", imagePath: `/uploads/${path.basename(imagePath)}` });

    Tesseract.recognize(imagePath, "eng+chi_sim", {
      logger: (m) => console.log(m.status, m.progress),
    })
      .then((result) => {
        const boxes = result.data.words || [];
        const detectedNames = boxes
          .map((w) => w.text.trim())
          .filter((w) => w.length > 0);
        global.lastDetectedNames = detectedNames;
        console.log("✅ OCR detected names:", detectedNames);
        io.emit("ocr-result", {
          names: detectedNames,
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

app.use("/uploads", express.static("uploads"));

// === Push attendance to Discord ===
app.get("/push-discord", async (req, res) => {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  const boss = req.query.boss || "Unknown Boss";

  const active = Array.from(voiceMembers.values()).map((m) => ({
    name: m.name,
    duration: Math.round((Date.now() - m.joinTime) / 1000),
  }));

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
    const buffer = await fsp.readFile(uploadedImagePath);
    formData.append("files[0]", buffer, path.basename(uploadedImagePath));
  }

  await fetch(webhook, {
    method: "POST",
    body: formData,
  });

  console.log("✅ Attendance pushed to Discord");
  res.send("ok");
});

// === Fetch existing voice members on startup ===
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
