const socket = io();
const activeBody = document.querySelector("#activeTable tbody");
const statusEl = document.getElementById("bot-status");
const ocrResultEl = document.getElementById("ocrResult");
const previewEl = document.getElementById("preview");
const imagePreviewEl = document.getElementById("imagePreview");

let activeMembers = [];
let ocrNames = [];
let uploadedImages = [];
let combinedList = [];

// ─── Bot Connection ───
socket.on("bot-status", (data) => {
  statusEl.textContent = `🟢 Bot Connected as ${data.name}`;
  statusEl.style.background = "#1a472a";
});

// ─── Live Active Voice Members ───
socket.on("update-attendance", (data) => {
  activeMembers = data.active;
  renderActive();
});

function renderActive() {
  activeBody.innerHTML = "";
  activeMembers.forEach((m) => {
    const minutes = Math.floor(m.duration / 60);
    const seconds = m.duration % 60;
    const row = `<tr><td>${m.name}</td><td>${minutes}m ${seconds}s</td></tr>`;
    activeBody.innerHTML += row;
  });
}

// ─── Upload OCR ───
document.getElementById("uploadBtn").onclick = async () => {
  const fileInput = document.getElementById("imageInput");
  if (!fileInput.files.length) return alert("Please select an image!");

  const file = fileInput.files[0];
  const formData = new FormData();
  formData.append("image", file);

  ocrResultEl.textContent = "⏳ Uploading and processing image...";

  const res = await fetch("/upload", { method: "POST", body: formData });
  const data = await res.json();

  if (data.error) {
    ocrResultEl.textContent = "❌ OCR failed.";
  } else {
    uploadedImages.push(URL.createObjectURL(file));
    ocrResultEl.textContent = "Processing OCR... Please wait...";
  }
};

// ─── Receive OCR Result ───
socket.on("ocr-result", (data) => {
  if (data.error) {
    ocrResultEl.textContent = "❌ OCR failed.";
    return;
  }

  // Append new names to existing list
  ocrNames.push(...data.names.filter((n) => !ocrNames.includes(n)));

  // Rebuild vertical table view
  const rows = ocrNames.map((n, i) => `<tr><td>${i + 1}</td><td>${n}</td></tr>`).join("");
  ocrResultEl.innerHTML = `
    <b>Detected Names:</b>
    <table style="width:100%; border-collapse: collapse; margin-top:5px;">
      <thead><tr><th>#</th><th>Name</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
});

// ─── Transfer List ───
document.getElementById("transferList").onclick = () => {
  const boss = document.getElementById("bossSelect").value;
  if (!ocrNames.length) return alert("No OCR names detected yet!");

  combinedList = ocrNames.map((ocrName) => {
    const voiceMatch = activeMembers.find((m) =>
      ocrName.toLowerCase().includes(m.name.toLowerCase())
    );
    const inVoice = voiceMatch ? "✅ Yes" : "❌ No";
    const inBoss = "✅ Yes"; // Assuming always active boss hunt for matched
    return {
      ocrName,
      voiceName: voiceMatch ? voiceMatch.name : "—",
      inVoice,
      inBoss,
    };
  });

  // Show combined list in Panel 3
  const tableRows = combinedList
    .map(
      (r) =>
        `<tr><td>${r.ocrName}</td><td>${r.voiceName}</td><td>${r.inVoice}</td><td>${r.inBoss}</td></tr>`
    )
    .join("");
  previewEl.innerHTML = `
    <table style="width:100%; border-collapse: collapse;">
      <thead>
        <tr><th>Image Detected</th><th>Voice Chat Nickname</th><th>Present in Voice</th><th>Present in Boss Hunt</th></tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
  `;

  imagePreviewEl.innerHTML = uploadedImages
    .map((src) => `<img src="${src}" />`)
    .join("");
};

// ─── Push to Discord ───
document.getElementById("pushDiscord").onclick = async () => {
  const boss = document.getElementById("bossSelect").value;
  await fetch(`/push-discord?boss=${encodeURIComponent(boss)}`);
  alert("✅ Attendance pushed to Discord!");
};
