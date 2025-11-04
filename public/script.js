const socket = io();
const activeBody = document.querySelector("#activeTable tbody");
const statusEl = document.getElementById("bot-status");
const ocrResultEl = document.getElementById("ocrResult");
const previewEl = document.getElementById("preview");

let activeMembers = [];
let ocrNames = [];
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

  const formData = new FormData();
  formData.append("image", fileInput.files[0]);

  ocrResultEl.textContent = "⏳ Uploading and processing image...";

  const res = await fetch("/upload", { method: "POST", body: formData });
  const data = await res.json();

  if (data.error) {
    ocrResultEl.textContent = "❌ OCR failed.";
  } else {
    ocrResultEl.textContent = "Processing OCR... Please wait...";
  }
};

// ─── Receive OCR Result ───
socket.on("ocr-result", (data) => {
  if (data.error) {
    ocrResultEl.textContent = "❌ OCR failed.";
    return;
  }

  ocrNames = data.names;
  ocrResultEl.innerHTML = `<b>Detected Names:</b><br>${ocrNames.join("<br>")}`;
});

// ─── Transfer List ───
document.getElementById("transferList").onclick = () => {
  const boss = document.getElementById("bossSelect").value;
  if (!ocrNames.length) return alert("No OCR names detected yet!");

  combinedList = activeMembers.map((m) => {
    const isPresent = ocrNames.some((n) => n.toLowerCase().includes(m.name.toLowerCase()));
    const minutes = Math.floor(m.duration / 60);
    const seconds = m.duration % 60;
    return `${m.name} — ${minutes}m ${seconds}s — ${boss} — ${isPresent ? "Present ✅" : "Absent ❌"}`;
  });

  previewEl.innerHTML = `<b>Preview:</b><br>${combinedList.join("<br>")}`;
};

// ─── Push to Discord ───
document.getElementById("pushDiscord").onclick = async () => {
  const boss = document.getElementById("bossSelect").value;
  await fetch(`/push-discord?boss=${encodeURIComponent(boss)}`);
  alert("✅ Attendance pushed to Discord!");
};
