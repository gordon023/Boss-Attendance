import express from "express";
import http from "http";
import { Server } from "socket.io";
import multer from "multer";
import Tesseract from "tesseract.js";
import fs from "fs";
import path from "path";
import sharp from "sharp";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const upload = multer({ dest: "uploads/" });

app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

// ────────────────────────────────
// 🖼️ OCR Upload & Detection Logic
// ────────────────────────────────
app.post("/upload", upload.single("image"), async (req, res) => {
  const imagePath = req.file.path;

  try {
    const processedPath = `${imagePath}-processed.png`;

    // Normalize image for OCR consistency
    await sharp(imagePath)
      .resize({ width: 1360, height: 768, fit: "inside" })
      .normalize()
      .toFile(processedPath);

    console.log("🟩 Processing image for OCR:", processedPath);

    const result = await Tesseract.recognize(processedPath, "eng+chi_sim", {
      logger: (m) => console.log(m),
    });

    // ✅ Updated OCR logic: detect names box by box
    const words = result.data.words || [];
    const boxes = [];

    for (const w of words) {
      if (!w.text || /^(x+|[\W_]+)$/i.test(w.text)) continue;
      const y = Math.round(w.bbox.y0 / 40); // vertical grouping
      if (!boxes[y]) boxes[y] = [];
      boxes[y].push(w.text.trim());
    }

    // Merge horizontally into per-box text
    const merged = boxes
      .map((group) => group.join("").trim())
      .filter((name) => name.length > 1);

    // 🔍 Refined Chinese + English splitting logic
    const finalNames = [];
    for (let name of merged) {
      name = name.replace(/\s+/g, "");

      // Keep Chinese+English combos (君王Axel, Aerokhart神)
      // Split only if more than one clear name glued
      name = name
        // Split between 2+ Chinese groups
        .replace(/([\u4e00-\u9fa5]{2,})(?=[\u4e00-\u9fa5]{2,})/g, "$1|")
        // Split between Chinese→English boundary
        .replace(/([\u4e00-\u9fa5]+)(?=[A-Za-z]+)/g, "$1|")
        // Split between English→Chinese boundary
        .replace(/([A-Za-z]+)(?=[\u4e00-\u9fa5]+)/g, "$1|")
        // Split CamelCase (AerokhartJinshi → Aerokhart|Jinshi)
        .replace(/([A-Za-z]{3,})(?=[A-Z][a-z]+)/g, "$1|");

      const parts = name.split("|").map((n) => n.trim()).filter(Boolean);
      finalNames.push(...parts);
    }

    console.log("✅ OCR per-box detected:", finalNames);

    io.emit("ocr-result", {
      names: finalNames,
      imagePath: `/uploads/${path.basename(imagePath)}`,
    });

    res.json({ success: true });
  } catch (error) {
    console.error("❌ OCR processing failed:", error);
    res.status(500).json({ error: "Failed to process image." });
  }
});

// ────────────────────────────────
// 🔌 Socket Connection
// ────────────────────────────────
io.on("connection", (socket) => {
  console.log("🟢 Client connected");
  socket.on("disconnect", () => console.log("🔴 Client disconnected"));
});

// ────────────────────────────────
// 🚀 Server Start
// ────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

