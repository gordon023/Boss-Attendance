const socket = io();
const tbody = document.querySelector("#bossTable tbody");

socket.on("update", (data) => {
  tbody.innerHTML = "";
  data.forEach(boss => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${boss.name}</td><td>${boss.date}</td><td>${boss.remaining}</td>`;
    tbody.appendChild(tr);
  });
});

function addBoss() {
  const name = document.getElementById("bossName").value;
  const date = document.getElementById("spawnDate").value;
  if (!name || !date) return alert("Please enter both fields");
  socket.emit("addBoss", { name, date, remaining: "calculating..." });
}

function clearFields() {
  document.getElementById("bossName").value = "";
  document.getElementById("spawnDate").value = "";
}

async function uploadImage() {
  const file = document.getElementById("imageUpload").files[0];
  if (!file) return alert("Choose an image");
  const formData = new FormData();
  formData.append("image", file);
  const res = await fetch("/upload", { method: "POST", body: formData });
  const data = await res.json();
  document.getElementById("ocrText").innerText = data.text || "No text detected.";
}

function updateDiscord() {
  socket.emit("updateToDiscord", "✅ Attendance updated successfully.");
}
