(() => {
  const $ = id => document.getElementById(id);
  const number = value => Number(value) || 0;
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[char]);
  let editingActivityId = null;

  function isAppleHealth(activity) {
    const source = String(activity?.source || '').toLowerCase();
    return Boolean(
      activity?.healthKitId || activity?.appleHealthId || activity?.importedFromAppleHealth ||
      source.includes('healthkit') || source.includes('apple health') ||
      source.includes('apple-health') || source.includes('apple salud')
    );
  }

  function sourceLabel(activity) {
    if (isAppleHealth(activity)) return ' · Apple Salud';
    return activity.source === 'watch' ? ' · reloj' : ' · estimación neta';
  }

  function renderEditableActivityHistory() {
    const history = $('activityHistory');
    if (!history) return;
    const activities = [...(data.activities || [])]
      .sort((a, b) => (b.createdAt || b.date || '').localeCompare(a.createdAt || a.date || ''))
      .slice(0, 8);

    history.innerHTML = activities.length ? activities.map(activity => {
      const locked = isAppleHealth(activity);
      return `<div class="activity-history">
        <div class="activity-history-copy">
          <strong>${escapeHtml(activity.type)}</strong>
          <small>${escapeHtml(activity.date)} · ${number(activity.minutes)} min · ${escapeHtml(activity.intensityLabel || activity.intensity)} · 🔥 ${Math.round(netActivityKcal(activity))} kcal activas${sourceLabel(activity)}</small>
        </div>
        ${locked
          ? '<span class="activity-locked">Gestionada por Apple Salud</span>'
          : `<div class="activity-history-actions">
              <button type="button" class="secondary" data-activity-edit="${escapeHtml(activity.id)}">✏️ Editar</button>
              <button type="button" class="danger" data-activity-delete="${escapeHtml(activity.id)}">🗑️ Eliminar</button>
            </div>`}
      </div>`;
    }).join('') : '<div class="empty-train">Todavía no registraste actividades.</div>';
  }

  function ensureCancelButton() {
    let button = $('cancelActivityEditBtn');
    if (button) return button;
    button = document.createElement('button');
    button.id = 'cancelActivityEditBtn';
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = 'Cancelar edición';
    button.style.display = 'none';
    $('saveActivityBtn')?.insertAdjacentElement('afterend', button);
    return button;
  }

  function resetActivityEditor() {
    editingActivityId = null;
    if ($('activityType')) $('activityType').value = 'Aero Local';
    if ($('activityMinutes')) $('activityMinutes').value = 55;
    if ($('activityIntensity')) $('activityIntensity').value = 'moderate';
    if ($('activityDate')) $('activityDate').value = today();
    if ($('activityWatchKcal')) $('activityWatchKcal').value = '';
    $('activityWatchBox')?.classList.remove('show');
    const saveButton = $('saveActivityBtn');
    if (saveButton) saveButton.textContent = 'Guardar actividad';
    const cancelButton = $('cancelActivityEditBtn');
    if (cancelButton) cancelButton.style.display = 'none';
    updateActivityEstimate();
  }

  function editActivityEntry(id) {
    const activity = (data.activities || []).find(item => item.id === id);
    if (!activity || isAppleHealth(activity)) return;
    editingActivityId = id;
    const type = $('activityType');
    if (type) type.value = [...type.options].some(option => option.value === activity.type) ? activity.type : 'Otra actividad';
    if ($('activityMinutes')) $('activityMinutes').value = number(activity.minutes) || 1;
    if ($('activityIntensity')) $('activityIntensity').value = ['light', 'moderate', 'vigorous'].includes(activity.intensity) ? activity.intensity : 'moderate';
    if ($('activityDate')) $('activityDate').value = activity.date || today();
    if (activity.source === 'watch') {
      if ($('activityWatchKcal')) $('activityWatchKcal').value = Math.round(number(activity.kcal));
      $('activityWatchBox')?.classList.add('show');
    } else {
      if ($('activityWatchKcal')) $('activityWatchKcal').value = '';
      $('activityWatchBox')?.classList.remove('show');
    }
    $('saveActivityBtn').textContent = 'Guardar cambios';
    ensureCancelButton().style.display = 'block';
    updateActivityEstimate();
    document.querySelector('.activity-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function deleteActivityEntry(id) {
    const activity = (data.activities || []).find(item => item.id === id);
    if (!activity || isAppleHealth(activity)) return;
    if (!confirm(`¿Eliminar ${activity.type} del ${activity.date}?`)) return;
    data.activities = data.activities.filter(item => item.id !== id);
    if (editingActivityId === id) resetActivityEditor();
    save();
  }

  function saveActivityEntry() {
    const minutes = number($('activityMinutes')?.value);
    const weight = currentActivityWeight();
    if (!weight) return alert('Cargá tu peso en Perfil o Progreso para estimar calorías.');
    if (!minutes) return alert('Ingresá la duración de la actividad.');
    const watch = number($('activityWatchKcal')?.value);
    const useWatch = $('activityWatchBox')?.classList.contains('show') && watch > 0;
    const kcal = useWatch ? Math.round(watch) : estimatedActivityKcal();
    const labels = { light: 'Suave', moderate: 'Moderada', vigorous: 'Fuerte' };
    const payload = {
      date: $('activityDate')?.value || today(),
      type: $('activityType')?.value || 'Otra actividad',
      minutes,
      intensity: $('activityIntensity')?.value || 'moderate',
      intensityLabel: labels[$('activityIntensity')?.value] || 'Moderada',
      kcal,
      source: useWatch ? 'watch' : 'estimate',
      calorieBasis: 'net',
      weight
    };
    const edited = Boolean(editingActivityId);
    if (edited) {
      const index = data.activities.findIndex(item => item.id === editingActivityId);
      if (index < 0) return resetActivityEditor();
      if (isAppleHealth(data.activities[index])) return alert('Los entrenamientos de Apple Salud se gestionan desde Apple Salud.');
      data.activities[index] = { ...data.activities[index], ...payload, updatedAt: new Date().toISOString() };
    } else {
      data.activities.push({ id: crypto.randomUUID(), ...payload, createdAt: new Date().toISOString() });
    }
    const type = payload.type;
    resetActivityEditor();
    save();
    alert(`✅ ${type} ${edited ? 'actualizado' : 'guardado'} · ${kcal} kcal activas`);
  }

  const style = document.createElement('style');
  style.textContent = '.activity-history-copy{min-width:0}.activity-history-actions{display:flex;gap:7px;flex:0 0 auto}.activity-history-actions button{width:auto;min-width:0;padding:8px 10px;font-size:12px}.activity-history-actions .danger{background:#3f1d24;color:#fecaca;border:1px solid #6b2933}.activity-locked{color:#7f9489;font-size:11px;white-space:nowrap}@media(max-width:520px){.activity-history{align-items:flex-start;flex-direction:column}.activity-history-actions{width:100%}.activity-history-actions button{flex:1}}';
  document.head.appendChild(style);

  const oldSaveButton = $('saveActivityBtn');
  if (oldSaveButton) {
    const newSaveButton = oldSaveButton.cloneNode(true);
    oldSaveButton.replaceWith(newSaveButton);
    newSaveButton.addEventListener('click', saveActivityEntry);
  }
  ensureCancelButton().addEventListener('click', resetActivityEditor);
  $('activityHistory')?.addEventListener('click', event => {
    const editButton = event.target.closest('[data-activity-edit]');
    const deleteButton = event.target.closest('[data-activity-delete]');
    if (editButton) editActivityEntry(editButton.dataset.activityEdit);
    if (deleteButton) deleteActivityEntry(deleteButton.dataset.activityDelete);
  });

  renderActivityHistory = renderEditableActivityHistory;
  renderEditableActivityHistory();
})();
