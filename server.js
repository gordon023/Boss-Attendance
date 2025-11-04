import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs-extra";
import dotenv from "dotenv";
import { Client, GatewayIntentBits } from "discord.js";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(cors());
app.use(express.static("public"));

const DATA_FILE = "./data/attendance.json";
await fs.ensureFile(DATA_FILE);
if (!(await fs.readFile(DATA_FILE, "utf8"))) await fs.writeFile(DATA_FILE, "[]");

// ✅ Discord Bot
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let voiceMembers = new Map(); // { id, name, joinTime }
let pastAttendance = [];

// ✅ Load existing attendance
fs.readJson(DATA_FILE)
  .then((data) => {
    pastAttendance = data;
    console.log("✅ Loaded attendance data.");
  })
  .catch(() => {
    pastAttendance = [];
    console.log("⚠️ No attendance data found, starting new.");
  });

client.once("clientReady", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  io.emit("bot-status", { connected: true, name: client.user.tag });
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  const channelId = process.env.DISCORD_VOICE_CHANNEL_ID;

  // ✅ Member joined
  if (newState.channelId === channelId && oldState.channelId !== channelId) {
    const member = newState.member;
    const nickname = member.displayName || member.user.username;

    voiceMembers.set(member.id, {
      id: member.id,
      name: nickname,
      joinTime: Date.now(),
    });
  }

  // ✅ Member left
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

// ✅ Push Discord Report (Active members)
app.get("/push-discord", async (req, res) => {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  const boss = req.query.boss || "Unknown Boss";

  const activeMembers = Array.from(voiceMembers.values()).map((m) => ({
    ...m,
    duration: Math.round((Date.now() - m.joinTime) / 1000),
  }));

  const report = activeMembers
    .map((m) => {
      const minutes = Math.floor(m.duration / 60);
      const seconds = m.duration % 60;
      return `${m.name} — ${minutes}m ${seconds}s — ${boss} — Present`;
    })
    .join("\n");

  const message = {
    content: `🎧 **Boss Attendance Report**\n**Boss:** ${boss}\n---------------------------------\n${
      report || "_No active members in VC._"
    }`,
  };

  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    res.send("ok");
  } catch (err) {
    console.error("❌ Discord webhook error:", err);
    res.status(500).send("error");
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🌐 Server running on port ${PORT}`)
);
