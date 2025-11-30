document.addEventListener('DOMContentLoaded', async () => {

  const mpdInput   = document.getElementById('mpd-input-sl');
  const groupInput = document.getElementById('group-input-sl');
  const saveBtn    = document.getElementById('save-btn-sl');
  const cancelBtn  = document.getElementById('cancel-btn-sl');
  const logsBtn    = document.getElementById('logs-btn-sl');

  window.mpd = "";
  window.group = "";

  // Valores iniciales visibles
  mpdInput.value = window.mpd;
  groupInput.value = window.group;

  // --- Función para verificar si hay cambios ---
  function checkChanges() {
    const changed =
      mpdInput.value.trim() !== window.mpd ||
      groupInput.value.trim() !== window.group;

    // Botón guardar
    if (changed) {
      saveBtn.disabled = false;
      saveBtn.classList.remove('btn-secondary');
      saveBtn.classList.add('btn-success');
    } else {
      saveBtn.disabled = true;
      saveBtn.classList.remove('btn-success');
      saveBtn.classList.add('btn-secondary');
    }

    // Botón cancelar (activo solo si hay cambios)
    cancelBtn.disabled = !changed;
  }

  // Detectar cambios en los inputs
  mpdInput.addEventListener('input', checkChanges);
  groupInput.addEventListener('input', checkChanges);

  // --- Guardar y aplicar ---
  saveBtn.addEventListener('click', async () => {
    const newMpd   = mpdInput.value.trim();
    const newGroup = groupInput.value.trim() || window.group;

    window.mpd   = newMpd;
    window.group = newGroup;

    // QoE usa window.mpd → refrescamos vídeo
    changeVideo();

    // Informar a SwarmLayer/peer.js
    await setInfo();

    // Actualizar botones tras guardar
    checkChanges();
  });

  // --- Cancelar ---
  cancelBtn.addEventListener('click', () => {
    mpdInput.value = window.mpd;
    groupInput.value = window.group;

    // Vuelve a desactivar los botones porque ya no hay cambios
    checkChanges();
  });

  // --- Logs ---
  logsBtn.addEventListener('click', () => {
    window.open("https://dashp2p.infinitebuffer.com/frag.html", "_blank");
  });

  // Estado inicial
  checkChanges();
});
