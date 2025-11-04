const socket = io();

// Sidebar navigation
document.querySelectorAll(".sidebar li").forEach(li => {
  li.addEventListener("click", () => {
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    document.getElementById(li.dataset.section).classList.add("active");
  });
});

// Boss list upload
document.getElementById("bossForm").addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.target;
  const file = form.file.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/upload-bosslist", { method: "POST", body: fd });
  const data = await res.json();
  if (data.success) renderBosses(data.bosses);
});

function renderBosses(bosses) {
  const div = document.getElementById("bossTable");
  div.innerHTML = "<h3>Boss List</h3>" + bosses.map(b =>
    `<div>${b.name} - ${new Date(b.time).toLocaleString()}</div>`
  ).join("");
}

// Attendance OCR upload
document.getElementById("attForm").addEventListener("submit", async e => {
  e.preventDefault();
  const file = e.target.file.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/upload-ocr", { method: "POST", body: fd });
  const data = await res.json();
  if (data.success) {
    document.getElementById("attText").textContent = data.text;
  }
});

socket.on("ocr-result", text => {
  document.getElementById("attText").textContent = text;
});
socket.on("boss-update", bosses => renderBosses(bosses));
