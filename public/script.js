const socket = io();
const activeBody = document.querySelector("#activeTable tbody");
const pastBody = document.querySelector("#pastTable tbody");
const statusEl = document.getElementById("bot-status");

// --- Keep last data persistent in browser ---
let savedData = JSON.parse(localStorage.getItem("attendanceData")) || { active: [], past: [] };
renderTables(savedData);

// --- Bot connection status ---
socket.on("bot-status", (data) => {
  statusEl.textContent = `🟢 Bot Connected as ${data.name}`;
  statusEl.style.background = "#1a472a";
});

// --- Live updates from server ---
socket.on("update-attendance", (data) => {
  localStorage.setItem("attendanceData", JSON.stringify(data));
  renderTables(data);
});

// --- Render Active & Past Tables ---
function renderTables(data) {
  activeBody.innerHTML = "";
  pastBody.innerHTML = "";

  // Active Voice Members (live countdown)
  data.active.forEach((m) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${m.name}</td>
      <td class="duration" data-join="${m.joinTime}">${formatDuration(m.duration)}</td>
      <td>Active</td>
    `;
    activeBody.appendChild(row);
  });

  // Past Attendance (left VC)
  data.past.forEach((m) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${m.name}</td>
      <td>${formatDuration(m.duration)}</td>
      <td>Present</td>
    `;
    pastBody.appendChild(row);
  });
}

// --- Live update timer every second ---
setInterval(() => {
  document.querySelectorAll(".duration").forEach((cell) => {
    const joinTime = parseInt(cell.dataset.join);
    const duration = Math.floor((Date.now() - joinTime) / 1000);
    cell.textContent = formatDuration(duration);
  });
}, 1000);

// --- Format duration nicely ---
function formatDuration(sec) {
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return `${min}m ${s}s`;
}

// --- Push to Discord button ---
document.getElementById("pushDiscord").onclick = async () => {
  const boss = document.getElementById("bossSelect").value;
  await fetch(`/push-discord?boss=${encodeURIComponent(boss)}`);
  alert(`✅ Attendance for ${boss} pushed to Discord!`);
};
