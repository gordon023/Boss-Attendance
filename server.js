import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs-extra";
import dotenv from "dotenv";
import { Client, GatewayIntentBits } from "discord.js";
import fetch from "node-fetch";
pastAttendance = await fs.readJson(DATA_FILE).catch(() => []);


dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(cors());
app.use(express.static("public"));

const DATA_FILE = "./data/attendance.json";
await fs.ensureFile(DATA_FILE);
if (!(await fs.readFile(DATA_FILE, "utf8"))) await fs.writeFile(DATA_FILE, "[]");

// Discord Bot
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let voiceMembers = new Map(); // store { id, name, joinTime }
let pastAttendance = [];

client.once("clientReady", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  io.emit("bot-status", { connected: true, name: client.user.tag });
});


client.on("voiceStateUpdate", (oldState, newState) => {
  const channelId = process.env.DISCORD_VOICE_CHANNEL_ID;

  // Member joined
  if (newState.channelId === channelId && oldState.channelId !== channelId) {
    voiceMembers.set(newState.id, {
      id: newState.id,
      name: newState.member.user.username,
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

app.get("/push-discord", async (req, res) => {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  const boss = req.query.boss || "Unknown Boss";

  const report = pastAttendance.slice(-20).map((m) => {
    const minutes = Math.floor(m.duration / 60);
    const seconds = m.duration % 60;
    return `${m.name} — ${minutes}m ${seconds}s — ${boss} — Present`;
  }).join("\n");

  const message = {
    content: `🎧 **Boss Attendance Report**\n**Boss:** ${boss}\n-----------------\n${report || "_No attendance recorded yet._"}`,
  };

  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });

  // keep data saved for persistence
  await fs.writeJson(DATA_FILE, pastAttendance);
  res.send("ok");
});


client.login(process.env.DISCORD_BOT_TOKEN);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));

