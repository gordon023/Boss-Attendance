// public/script.js
const socket = io();
const activeTbody = document.querySelector("#activeTable tbody");
const detectedListEl = document.getElementById("detectedList");
const previewImage = document.getElementById("previewImage");
const combineTbody = document.querySelector("#combineTable tbody");
const previewTbody = document.querySelector("#previewTable tbody");
const previewImageBox = document.getElementById("previewImageBox");
const statusEl = document.getElementById("bot-status");

let activeMembers = [];   // from server
let detectedNames = [];   // from OCR
let currentPreview = [];  // final list (transferred)
let currentBoss = document.getElementById("bossSelectTop").value;

// update boss selection synchronize (top control)
document.getElementById("bossSelectTop").addEventListener("change", (e) => {
  currentBoss = e.target.value;
});

// socket events
socket.on("bot-status", (d) => {
  statusEl.textContent = `🟢 Bot Connected as ${d.name}`;
  statusEl.style.background = "#1a472a";
});

socket.on("update-attendance", (data) => {
  activeMembers = data.active || [];
  detectedNames = data.detected || [];
  // preview image url if any
  if (data.image) {
    previewImage.src = data.image;
    previewImageBox.innerHTML = `<img src="${data.image}" alt="uploaded" />`;
  }
  renderActive();
  renderDetected();
  buildCombineTable();
  // persist to localStorage for page refresh retention
  localStorage.setItem("vc_attendance_data", JSON.stringify({ activeMembers, detectedNames, image: data.image }));
});

// on page load, try restore state
const saved = JSON.parse(localStorage.getItem("vc_attendance_data") || "null");
if (saved) {
  if (saved.image) { previewImage.src = saved.image; previewImageBox.innerHTML = `<img src="${saved.image}" alt="uploaded" />`; }
  if (saved.detectedNames) detectedNames = saved.detectedNames;
  if (saved.activeMembers) activeMembers = saved.activeMembers;
  renderActive();
  renderDetected();
  buildCombineTable();
}

// render active VC
function renderActive(){
  activeTbody.innerHTML = "";
  activeMembers.forEach(m => {
    const mins = Math.floor(m.duration / 60);
    const secs = m.duration % 60;
    const tr = `<tr><td>${m.name}</td><td>${mins}m ${secs}s</td></tr>`;
    activeTbody.innerHTML += tr;
  });
}

// render detected vertical
function renderDetected(){
  detectedListEl.innerHTML = "";
  detectedNames.forEach(n => {
    const li = document.createElement("li");
    li.textContent = n;
    detectedListEl.appendChild(li);
  });
}

// build combined OCR vs voice table horizontally
function buildCombineTable(){
  combineTbody.innerHTML = "";
  // for each detected name, try find best match in activeMembers (case-insensitive substring)
  detectedNames.forEach(o => {
    const found = activeMembers.find(v => v.name && v.name.toLowerCase().includes(o.toLowerCase())) || null;
    const match = found ? "Present ✅" : "Absent ❌";
    const tr = `<tr><td>${o}</td><td>${found?found.name:"—"}</td><td>${match}</td></tr>`;
    combineTbody.innerHTML += tr;
  });
  // Also show active members not in OCR list (they may be missed by OCR)
  activeMembers.forEach(v=>{
    const found = detectedNames.find(o=> v.name && v.name.toLowerCase().includes(o.toLowerCase()));
    if (!found) {
      const tr = `<tr><td>—</td><td>${v.name}</td><td>Absent ❌</td></tr>`;
      combineTbody.innerHTML += tr;
    }
  });
}

// Upload + OCR
document.getElementById("uploadBtn").addEventListener("click", async () => {
  const input = document.getElementById("imageInput");
  if (!input.files || !input.files[0]) return alert("Choose an image first");
  const fd = new FormData();
  fd.append("image", input.files[0]);

  document.getElementById("ocrResult").textContent = "⏳ Processing...";
  const res = await fetch("/upload", { method: "POST", body: fd });
  if (!res.ok) { alert("Upload failed"); return; }
  const data = await res.json();
  detectedNames = data.names || [];
  if (data.image) {
    previewImage.src = data.image;
    previewImageBox.innerHTML = `<img src="${data.image}" alt="uploaded" />`;
  }
  renderDetected();
  buildCombineTable();
  // update localStorage snapshot
  localStorage.setItem("vc_attendance_data", JSON.stringify({ activeMembers, detectedNames, image: data.image }));
  document.getElementById("ocrResult").innerHTML = "<b>Detected names (vertical)</b>";
});

// Transfer list button (moved to Panel 2)
document.getElementById("transferList").addEventListener("click", () => {
  currentBoss = document.getElementById("bossSelectTop").value;
  // Build preview rows comparing detectedNames with activeMembers
  const preview = [];
  // add all active members with present/absent by detected list
  activeMembers.forEach(m=>{
    const present = detectedNames.some(n => n && m.name && m.name.toLowerCase().includes(n.toLowerCase()));
    preview.push({
      name: m.name,
      duration: m.duration,
      boss: currentBoss,
      status: present ? "Present" : "Absent"
    });
  });
  // save preview to currentPreview and render
  currentPreview = preview;
  renderPreviewTable();
  // store in localStorage
  localStorage.setItem("vc_preview", JSON.stringify({ preview: currentPreview, image: previewImage.src || null, boss: currentBoss }));
});

// render preview table
function renderPreviewTable(){
  previewTbody.innerHTML = "";
  previewImageBox.innerHTML = previewImage.src ? `<img src="${previewImage.src}" alt="img" />` : "";
  currentPreview.forEach(row=>{
    const mins = Math.floor(row.duration / 60);
    const secs = row.duration % 60;
    const tr = `<tr><td>${row.name}</td><td>${mins}m ${secs}s</td><td>${row.boss}</td><td>${row.status}</td></tr>`;
    previewTbody.innerHTML += tr;
  });
}

// Push to Discord
document.getElementById("pushDiscord").addEventListener("click", async () => {
  // get boss and ensure preview exists
  const stored = JSON.parse(localStorage.getItem("vc_preview") || "null");
  const boss = stored?.boss || document.getElementById("bossSelectTop").value;
  // call backend endpoint
  const res = await fetch(`/push-discord?boss=${encodeURIComponent(boss)}`, { method: "POST" });
  if (res.ok) {
    alert("✅ Pushed to Discord");
    // clear preview
    currentPreview = [];
    previewTbody.innerHTML = "";
    // clear stored preview
    localStorage.removeItem("vc_preview");
  } else {
    alert("❌ Push failed");
  }
});

// tick to update durations UI from activeMembers every second
setInterval(()=>{
  // update durations locally if activeMembers had joinTime (server emits fresh durations every few seconds)
  activeMembers = activeMembers.map(m => ({ ...m, duration: Math.round((Date.now() - (m.joinTime || Date.now())) / 1000) }));
  renderActive();
  // also update preview durations
  if (currentPreview.length) {
    currentPreview = currentPreview.map(p => {
      const found = activeMembers.find(a => a.name === p.name);
      return found ? { ...p, duration: found.duration } : p;
    });
    renderPreviewTable();
  }
}, 1000);
