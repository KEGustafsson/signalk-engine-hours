const url =
  window.location.origin + '/plugins/signalk-engine-hours/hours';
let jsonData = null;
let isSaving = false;
let isFetching = false;

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
    const matches = pathData.path.match(/[^.]+\.(.+)\.[^.]+/);
    const rawName = matches ? matches[1] : 'unknown';
    const safeAttrName = escapeAttr(rawName);
    const runTimeHours = (pathData.runTime / 3600).toFixed(2);
    const runTimeTripHours = (pathData.runTimeTrip / 3600).toFixed(2);

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
  if (jsonData.paths.length <= index) return;
  const matches = jsonData.paths[index].path.match(/[^.]+\.(.+)\.[^.]+/);
  const name = matches ? matches[1] : 'this engine';
  if (!confirm(`Delete ${name}? This cannot be undone after saving.`)) return;
  jsonData.paths.splice(index, 1);
  displayJsonData();
  document.getElementById('save-button').style.display = '';
}

async function saveChanges() {
  if (isSaving) return;

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
    } else if (field === 'runTime' || field === 'runTimeTrip') {
      updates.push({ pathIndex, field, value: Math.round(inputValue * 3600) });
    }
  }
  if (errors.length > 0) {
    errors.forEach((msg) => displayErrorMessage(msg));
    return;
  }

  isSaving = true;
  setButtonsEnabled(false);
  try {
    updates.forEach(({ pathIndex, field, value }) => {
      jsonData.paths[pathIndex][field] = value;
    });
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(jsonData),
    });
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    fetchData();
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
  }, 8000);
}

function checkChanges() {
  const saveButton = document.getElementById('save-button');
  const inputs = document.querySelectorAll(
    'input[data-path-index][data-field]',
  );
  let dataChanged = false;

  for (let i = 0; i < inputs.length; i++) {
    const pathIndex = parseInt(inputs[i].dataset.pathIndex, 10);
    const field = inputs[i].dataset.field;
    const inputValue = parseFloat(inputs[i].value);
    if (isNaN(inputValue)) {
      dataChanged = true;
      break;
    }
    const originalDisplayed = parseFloat(
      (jsonData.paths[pathIndex][field] / 3600).toFixed(2),
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
