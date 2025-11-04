const socket = io();
let activeData = [];
let detected = [];
let currentBoss = "Unknown";

socket.on("update-attendance", (data) => {
  activeData = data.active;
  detected = data.detected || [];

  const activeBody = document.getElementById("activeBody");
  activeBody.innerHTML = "";
  activeData.forEach(m => {
    const mins = Math.floor(m.duration / 60);
    const secs = m.duration % 60;
    activeBody.innerHTML += `<tr><td>${m.name}</td><td>${mins}m ${secs}s</td></tr>`;
  });

  const detectedList = document.getElementById("detectedNames");
  detectedList.innerHTML = detected.map(n => `<li>${n}</li>`).join("");

  if (data.image) document.getElementById("preview").src = data.image;
});

document.getElementById("uploadForm").onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target;
  const res = await fetch("/upload", { method: "POST", body: new FormData(form) });
  const result = await res.json();
  alert("✅ Image uploaded and processed!");
};

document.getElementById("transferBtn").onclick = () => {
  const bossSelect = document.getElementById("bossSelect");
  currentBoss = bossSelect.value;

  const previewBody = document.getElementById("previewBody");
  previewBody.innerHTML = activeData.map(m => {
    const mins = Math.floor(m.duration / 60);
    const secs = m.duration % 60;
    const present = detected.includes(m.name) ? "Present" : "Absent";
    return `<tr><td>${m.name}</td><td>${mins}m ${secs}s</td><td>${present}</td></tr>`;
  }).join("");
};

document.getElementById("pushDiscord").onclick = async () => {
  await fetch(`/push-discord?boss=${encodeURIComponent(currentBoss)}`);
  alert(`✅ Attendance for ${currentBoss} pushed to Discord!`);
};
