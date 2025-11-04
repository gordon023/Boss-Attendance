const socket = io();
const activeBody = document.querySelector("#activeTable tbody");
const pastBody = document.querySelector("#pastTable tbody");
const statusEl = document.getElementById("bot-status");

socket.on("bot-status", (data) => {
  statusEl.textContent = `🟢 Bot Connected as ${data.name}`;
  statusEl.style.background = "#1a472a";
});

socket.on("update-attendance", (data) => {
  activeBody.innerHTML = "";
  data.active.forEach((m) => {
    const row = `<tr><td>${m.name}</td><td>${m.duration}s</td></tr>`;
    activeBody.innerHTML += row;
  });

  pastBody.innerHTML = "";
  data.past.forEach((m) => {
    const row = `<tr><td>${m.name}</td><td>${m.duration}s</td></tr>`;
    pastBody.innerHTML += row;
  });
});

document.getElementById("pushDiscord").onclick = async () => {
  const boss = document.getElementById("bossSelect").value;
  await fetch(`/push-discord?boss=${encodeURIComponent(boss)}`);
  alert(`✅ Attendance for ${boss} pushed to Discord!`);
};
