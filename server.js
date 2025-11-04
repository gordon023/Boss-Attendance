import express from "express";
import http from "http";
import { Server } from "socket.io";
import multer from "multer";
import Tesseract from "tesseract.js";
import fs from "fs-extra";
import path from "path";
import sharp from "sharp";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const upload = multer({ dest: "uploads/" });

app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

app.post("/upload", upload.single("image"), async (req, res) => {
  const imagePath = req.file.path;

  try {
    const processedPath = `${imagePath}-processed.png`;

    await sharp(imagePath)
      .resize({ width: 1360, height: 768, fit: "inside" })
      .normalize()
      .toFile(processedPath);

    console.log("🟩 Processing image for OCR:", processedPath);

    // -------------------------------
    // OCR Processing Section
    // -------------------------------
    Tesseract.recognize(processedPath, "eng+chi_sim", {
      logger: (m) => console.log(m.status, m.progress),
    })
      .then((result) => {
        const words = result.data.words || [];
        if (!words.length) throw new Error("No text found");

        // Step 1. Filter valid words
        const valid = words
          .map((w) => ({
            text: w.text.trim(),
            x: w.bbox.x0,
            y: w.bbox.y0,
          }))
          .filter(
            (w) =>
              w.text &&
              w.text.length > 0 &&
              !/^[^A-Za-z0-9\u4e00-\u9fa5]+$/.test(w.text) &&
              w.text.length < 20
          );

        // Step 2. Cluster vertically by Y (row groups)
        const rowGroups = [];
        valid.forEach((word) => {
          let row = rowGroups.find((r) => Math.abs(r.y - word.y) < 30);
          if (!row) {
            row = { y: word.y, words: [] };
            rowGroups.push(row);
          }
          row.words.push(word);
        });

        // Step 3. Sort each row horizontally (x position)
        rowGroups.forEach((r) => r.words.sort((a, b) => a.x - b.x));

        // Step 4. Merge horizontally adjacent characters in each row
        const horizontalMerged = rowGroups.map((r) =>
          r.words.map((w) => w.text).join("")
        );

        // Step 5. Group columns (for multiple boxes)
        const sortedRows = rowGroups.sort((a, b) => a.y - b.y);
        const columns = [];
        sortedRows.forEach((row) => {
          const lastCol = columns[columns.length - 1];
          if (!lastCol || Math.abs(row.y - lastCol[lastCol.length - 1].y) > 60) {
            columns.push([row]);
          } else {
            lastCol.push(row);
          }
        });

        // Step 6. Flatten names per column
        const mergedNames = columns.flatMap((col) =>
          col.map((r) => r.words.map((w) => w.text).join(""))
        );

        // Step 7. Combine Chinese + English names like 君王Axel or Aerokhart神
        const finalNames = [];
        mergedNames.forEach((name) => {
          if (!name) return;
          name = name.replace(/\s+/g, "");
          name = name.replace(/([A-Za-z]+)(?=[\u4e00-\u9fa5])/g, "$1|");
          name = name.replace(/([\u4e00-\u9fa5]+)(?=[A-Za-z])/g, "$1|");
          const parts = name.split("|").map((p) => p.trim()).filter(Boolean);
          finalNames.push(...parts);
        });

        // Step 8. Clean duplicates and meaningless fragments
        const cleanNames = [
          ...new Set(
            finalNames.filter(
              (n) =>
                n.length > 1 &&
                !/^(x+|[0-9]+|[^\u4e00-\u9fa5A-Za-z]+)$/i.test(n)
            )
          ),
        ];

        console.log("✅ Final grouped names:", cleanNames);
        io.emit("ocr-result", {
          names: cleanNames,
          imagePath: `/uploads/${path.basename(imagePath)}`,
        });
      })
      .catch((err) => {
        console.error("❌ OCR error:", err);
        io.emit("ocr-result", { error: "OCR failed." });
      });

    res.json({ success: true });
  } catch (error) {
    console.error("❌ OCR processing failed:", error);
    res.status(500).json({ error: "Failed to process image." });
  }
});

io.on("connection", (socket) => {
  console.log("🟢 Client connected");
  socket.on("disconnect", () => console.log("🔴 Client disconnected"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
