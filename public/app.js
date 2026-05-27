const url = window.location.origin + '/plugins/signalk-engine-hours/hours';
const SECONDS_PER_HOUR = 3600;
const ERROR_TIMEOUT_MS = 8000;
const EDITABLE_FIELDS = ['runTime', 'runTimeTrip'];
let jsonData = null;
let isSaving = false;
let isFetching = false;

function clearErrors() {
  const errorContainer = document.getElementById('error-container');
  if (errorContainer) errorContainer.innerHTML = '';
}

function escapeAttr(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function setButtonsEnabled(enabled) {
  document.getElementById('reload-button').disabled = !enabled;
  if (!enabled) {
    document.getElementById('save-button').style.display = 'none';
  } else {
    checkChanges();
  }
}

async function fetchData() {
  if (isFetching) return;
  isFetching = true;
  clearErrors();
  setButtonsEnabled(false);
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    jsonData = await response.json();
    if (!jsonData || !Array.isArray(jsonData.paths)) {
      jsonData = { paths: [] };
      displayErrorMessage('Invalid data received from server');
    }
    displayJsonData();
  } catch (error) {
    displayErrorMessage(error.message);
  } finally {
    isFetching = false;
    setButtonsEnabled(true);
  }
}

function displayJsonData() {
  const jsonContainer = document.getElementById('json-container');
  jsonContainer.innerHTML = '';

  jsonData.paths.forEach((pathData, index) => {
    const rawPath =
      pathData && typeof pathData.path === 'string' ? pathData.path : '';
    const matches = rawPath.match(/[^.]+\.(.+)\.[^.]+/);
    const rawName = matches ? matches[1] : 'unknown';
    const safeAttrName = escapeAttr(rawName);
    const runTimeSec = Number(pathData && pathData.runTime) || 0;
    const runTimeTripSec = Number(pathData && pathData.runTimeTrip) || 0;
    const runTimeHours = (runTimeSec / SECONDS_PER_HOUR).toFixed(2);
    const runTimeTripHours = (runTimeTripSec / SECONDS_PER_HOUR).toFixed(2);

    const card = document.createElement('div');
    card.className = 'engine-card';

    const headerEl = document.createElement('div');
    headerEl.className = 'engine-header';

    const nameEl = document.createElement('div');
    nameEl.className = 'engine-name';
    const icon = document.createElement('i');
    icon.className = 'fas fa-cog';
    nameEl.appendChild(icon);
    nameEl.appendChild(document.createTextNode(' propulsion.' + rawName));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.innerHTML = '<i class="fas fa-trash"></i> Delete';
    deleteBtn.addEventListener('click', () => deleteSection(index));

    headerEl.appendChild(nameEl);
    headerEl.appendChild(deleteBtn);
    card.appendChild(headerEl);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'engine-body';
    bodyEl.innerHTML = `
      <div class="metric-row">
        <div class="metric-group">
          <label class="metric-label" for="runTime${index}">Total Runtime</label>
          <div class="metric-wrapper">
            <input class="metric-input" type="number" step="1.0" min="0"
                   id="runTime${index}"
                   data-path-index="${index}" data-field="runTime"
                   value="${runTimeHours}"
                   aria-label="Total Runtime for ${safeAttrName}">
            <span class="metric-unit">hours</span>
          </div>
        </div>
        <div class="metric-group">
          <label class="metric-label" for="runTimeTrip${index}">Trip Runtime</label>
          <div class="metric-wrapper">
            <input class="metric-input" type="number" step="1.0" min="0"
                   id="runTimeTrip${index}"
                   data-path-index="${index}" data-field="runTimeTrip"
                   value="${runTimeTripHours}"
                   aria-label="Trip Runtime for ${safeAttrName}">
            <span class="metric-unit">hours</span>
          </div>
        </div>
      </div>
    `;
    card.appendChild(bodyEl);
    jsonContainer.appendChild(card);
  });

  checkChanges();
}

function deleteSection(index) {
  if (
    !jsonData ||
    !Array.isArray(jsonData.paths) ||
    jsonData.paths.length <= index
  ) {
    return;
  }
  const entry = jsonData.paths[index];
  const entryPath = entry && typeof entry.path === 'string' ? entry.path : '';
  const matches = entryPath.match(/[^.]+\.(.+)\.[^.]+/);
  const name = matches ? matches[1] : 'this engine';
  if (!confirm(`Delete ${name}? This cannot be undone after saving.`)) return;
  jsonData.paths.splice(index, 1);
  displayJsonData();
  document.getElementById('save-button').style.display = '';
}

async function saveChanges() {
  if (isSaving) return;
  if (!jsonData || !Array.isArray(jsonData.paths)) return;

  clearErrors();

  // Validate all inputs before locking the UI — collect all errors at once
  const inputs = document.querySelectorAll(
    'input[data-path-index][data-field]',
  );
  const errors = [];
  const updates = [];
  for (let i = 0; i < inputs.length; i++) {
    const pathIndex = parseInt(inputs[i].dataset.pathIndex, 10);
    const field = inputs[i].dataset.field;
    const inputValue = parseFloat(inputs[i].value);
    if (isNaN(inputValue) || inputValue < 0) {
      errors.push(
        `Invalid value for ${field} at engine ${pathIndex + 1}. Must be a non-negative number.`,
      );
    } else if (EDITABLE_FIELDS.includes(field)) {
      updates.push({
        pathIndex,
        field,
        value: Math.round(inputValue * SECONDS_PER_HOUR),
      });
    }
  }
  if (errors.length > 0) {
    errors.forEach((msg) => displayErrorMessage(msg));
    return;
  }

  // Build the payload without mutating jsonData — on a failed save the
  // in-memory state must stay in sync with what the server actually has.
  const payload = {
    ...jsonData,
    paths: jsonData.paths.map((p) => ({ ...p })),
  };
  updates.forEach(({ pathIndex, field, value }) => {
    if (payload.paths[pathIndex]) payload.paths[pathIndex][field] = value;
  });

  isSaving = true;
  setButtonsEnabled(false);
  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    // Reload from the server (source of truth) and let it own button state.
    await fetchData();
  } catch (error) {
    displayErrorMessage(error.message);
  } finally {
    isSaving = false;
    setButtonsEnabled(true);
  }
}

function displayErrorMessage(message) {
  const errorContainer = document.getElementById('error-container');
  const errorDiv = document.createElement('div');
  errorDiv.className = 'alert-modern alert-danger-modern';
  errorDiv.setAttribute('role', 'alert');

  const textSpan = document.createElement('span');
  textSpan.textContent = message;
  errorDiv.appendChild(textSpan);

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'alert-dismiss';
  dismissBtn.innerHTML = '&times;';
  dismissBtn.setAttribute('aria-label', 'Dismiss error');
  dismissBtn.addEventListener('click', () => errorDiv.remove());
  errorDiv.appendChild(dismissBtn);

  errorContainer.appendChild(errorDiv);
  setTimeout(() => {
    if (errorDiv.parentNode) errorDiv.remove();
  }, ERROR_TIMEOUT_MS);
}

function checkChanges() {
  const saveButton = document.getElementById('save-button');
  if (!jsonData || !Array.isArray(jsonData.paths)) {
    saveButton.style.display = 'none';
    return;
  }
  const inputs = document.querySelectorAll(
    'input[data-path-index][data-field]',
  );
  let dataChanged = false;

  for (let i = 0; i < inputs.length; i++) {
    const pathIndex = parseInt(inputs[i].dataset.pathIndex, 10);
    const field = inputs[i].dataset.field;
    const entry = jsonData.paths[pathIndex];
    if (!entry) continue;
    const inputValue = parseFloat(inputs[i].value);
    if (isNaN(inputValue)) {
      dataChanged = true;
      break;
    }
    const originalDisplayed = parseFloat(
      ((Number(entry[field]) || 0) / SECONDS_PER_HOUR).toFixed(2),
    );
    if (inputValue !== originalDisplayed) {
      dataChanged = true;
      break;
    }
  }

  saveButton.style.display = dataChanged ? '' : 'none';
}

document.getElementById('reload-button').addEventListener('click', fetchData);
document.getElementById('save-button').addEventListener('click', saveChanges);
document.addEventListener('input', (event) => {
  const input = event.target;
  if (input.tagName === 'INPUT' && input.type === 'number') {
    checkChanges();
  }
});

fetchData();
