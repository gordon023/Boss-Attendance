import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import multer from "multer";
import fs from "fs-extra";
import path from "path";
import Tesseract from "tesseract.js";

const app = express();
const server = createServer(app);
const io = new Server(server);
const PORT = 10000; // Render hard-coded port

app.use(express.json());
app.use(express.static("public"));
app.use("/data", express.static("data"));
fs.ensureDirSync("uploads");
fs.ensureDirSync("data");

const bossDataPath = "./data/bossData.json";
if (!fs.existsSync(bossDataPath)) fs.writeJSONSync(bossDataPath, []);

const upload = multer({ dest: "uploads/" });

// --- OCR handler ---
app.post("/upload-ocr", upload.single("file"), async (req, res) => {
  try {
    const { path: filePath } = req.file;
    const { data: { text } } = await Tesseract.recognize(filePath, "eng");
    res.json({ success: true, text });
    io.emit("ocr-result", text);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Boss list upload (image/text) ---
app.post("/upload-bosslist", upload.single("file"), async (req, res) => {
  try {
    const { path: filePath } = req.file;
    const { data: { text } } = await Tesseract.recognize(filePath, "eng");
    const lines = text.split("\n").filter(l => l.trim());
    const bossEntries = lines.map(line => ({ name: line, time: Date.now() }));
    await fs.writeJSON(bossDataPath, bossEntries);
    io.emit("boss-update", bossEntries);
    res.json({ success: true, bosses: bossEntries });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Placeholder for your Discord connection code ---
/*
   import { Client, GatewayIntentBits } from "discord.js";
   const client = new Client({ intents: [...] });
   client.on("voiceStateUpdate", ...);
   client.login(process.env.DISCORD_BOT_TOKEN);
*/

// --- Realtime connections ---
io.on("connection", socket => {
  console.log("Client connected");
  socket.on("disconnect", () => console.log("Client disconnected"));
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
