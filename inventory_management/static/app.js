////////////////////////////////////////////
// Helpers
////////////////////////////////////////////
const statusMessage = document.getElementById('statusMessage');

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data.error?.message || 'Request failed';
    const details = data.error?.details ? `: ${data.error.details.join(', ')}` : '';
    throw new Error(message + details);
  }

  return data;
}

function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle('error', isError);
  statusMessage.classList.toggle('hidden', !message);
}

const API = {
  search: q => requestJson('/search?q=' + encodeURIComponent(q)).then(data => data.items || []),
  create: data => requestJson('/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }),
  update: data => requestJson('/update', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }),
  del: id => requestJson('/delete', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  })
};

////////////////////////////////////////////
// 'Create' Form + show/hide logic
////////////////////////////////////////////
const toggleFormBtn = document.getElementById('toggleFormBtn');
const createSection = document.getElementById('createSection');

function toggleFormDisplay() {
  createSection.classList.toggle('hidden');
  toggleFormBtn.classList.toggle('form-open');
  toggleFormBtn.textContent = toggleFormBtn.classList.contains('form-open') ? '-' : '+';
}

toggleFormBtn.addEventListener('click', toggleFormDisplay);

document.getElementById('createForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const data = {
    object_name: document.getElementById('name').value,
    qnty: parseInt(document.getElementById('qnty').value, 10),
    location: document.getElementById('location').value,
    category_tags: document.getElementById('tags').value.split(',').map(t => t.trim()).filter(Boolean)
  };

  try {
    await API.create(data);
    form.reset();
    toggleFormDisplay();
    setStatus('Item created');
    loadResults();
  } catch (error) {
    setStatus(error.message, true);
  }
});

/////////////////////////////////////////
// Search bar animation + logic
/////////////////////////////////////////
const searchInput = document.getElementById('searchInput');
const searchContainer = document.getElementById('searchContainer');
const resultsContainer = document.getElementById('resultsContainer');

searchInput.addEventListener('input', function () {
  const q = this.value.trim();
  if (q !== '') {
    searchContainer.classList.add('active');
    resultsContainer.classList.add('active');
    loadResults();
  } else {
    searchContainer.classList.remove('active');
    resultsContainer.classList.remove('active');
    resultsContainer.textContent = '';
    setStatus('');
  }
});

searchContainer.classList.remove('active');
resultsContainer.classList.remove('active');
resultsContainer.textContent = '';

////////////////////////////////////////////
// Tile functions
////////////////////////////////////////////
function buildTile(item) {
  const li = document.createElement('li');
  li.className = 'tile not-editable';

  function makeBtn({ className, text, title, handler }) {
    const btn = document.createElement('button');
    btn.className = className;
    btn.textContent = text;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.type = 'button';
    btn.addEventListener('click', handler);
    return btn;
  }

  function makeSpan({ value, className, isEditable = false }) {
    const span = document.createElement('span');
    span.textContent = value;
    span.contentEditable = isEditable;
    span.className = className;
    return span;
  }

  function renderDisplay() {
    li.textContent = '';
    li.classList.add('not-editable');

    const headerDiv = document.createElement('div');
    headerDiv.className = 'tile-header';
    headerDiv.appendChild(makeBtn({
      className: 'tile-x-btn',
      text: 'x',
      title: 'Delete item',
      handler: async e => {
        e.stopPropagation();
        if (!confirm('Delete item?')) {
          return;
        }
        try {
          await API.del(item.id);
          setStatus('Item deleted');
          loadResults();
        } catch (error) {
          setStatus(error.message, true);
        }
      }
    }));

    if (item.qnty > 1) {
      headerDiv.appendChild(makeSpan({
        value: `[${item.qnty}]`,
        className: 'tile-qty'
      }));
    }

    headerDiv.appendChild(makeSpan({
      value: item.object_name,
      className: 'tile-name'
    }));

    headerDiv.appendChild(makeBtn({
      className: 'tile-action-btn',
      text: 'edit',
      title: 'Edit item',
      handler: e => {
        e.stopPropagation();
        li.classList.remove('not-editable');
        renderEdit();
      }
    }));

    li.appendChild(headerDiv);

    const loc = document.createElement('div');
    loc.className = 'location';
    loc.textContent = item.location;
    li.appendChild(loc);

    li.appendChild(makeTagsDiv(item.category_tags));
  }

  function renderEdit() {
    li.textContent = '';

    let nameInput;
    let qtyInput;
    let locInput;
    let tagsInput;

    li.appendChild(makeBtn({
      className: 'tile-action-btn',
      text: 'save',
      title: 'Update item',
      handler: async e => {
        e.stopPropagation();
        const updated = {
          id: item.id,
          object_name: nameInput.textContent.trim(),
          qnty: parseInt(qtyInput.textContent, 10),
          location: locInput.textContent.trim(),
          category_tags: tagsInput.textContent.split(',').map(t => t.trim()).filter(Boolean)
        };

        try {
          await API.update(updated);
          setStatus('Item updated');
          loadResults();
        } catch (error) {
          setStatus(error.message, true);
        }
      }
    }));

    li.appendChild(makeBtn({
      className: 'tile-x-btn',
      text: 'x',
      title: 'Cancel edit',
      handler: e => {
        e.stopPropagation();
        renderDisplay();
      }
    }));

    const headerDiv = document.createElement('div');
    headerDiv.className = 'tile-header';

    qtyInput = makeSpan({
      value: item.qnty,
      className: 'editable-span',
      isEditable: true
    });
    headerDiv.appendChild(qtyInput);

    nameInput = makeSpan({
      value: item.object_name,
      className: 'editable-span',
      isEditable: true
    });
    headerDiv.appendChild(nameInput);
    li.appendChild(headerDiv);

    locInput = makeSpan({
      value: item.location,
      className: 'editable-span location',
      isEditable: true
    });
    li.appendChild(locInput);

    tagsInput = makeSpan({
      value: item.category_tags.join(', '),
      className: 'editable-span tags',
      isEditable: true
    });
    li.appendChild(tagsInput);
  }

  function makeTagsDiv(tags) {
    const tagDiv = document.createElement('div');
    tagDiv.className = 'tags';

    tags.forEach(tag => {
      const tagSpan = document.createElement('span');
      tagSpan.className = 'tag';
      tagSpan.textContent = tag;
      tagDiv.appendChild(tagSpan);
    });

    tagDiv.addEventListener('click', () => {
      tagDiv.classList.toggle('show-overflowed-tags');
    });

    return tagDiv;
  }

  renderDisplay();
  return li;
}

function render(items) {
  resultsContainer.textContent = '';
  items.forEach(it => resultsContainer.appendChild(buildTile(it)));
}

async function loadResults() {
  const q = searchInput.value.trim();
  if (q === '') {
    resultsContainer.textContent = '';
    return;
  }

  try {
    const items = await API.search(q);
    render(items);
    setStatus(items.length ? '' : 'No matching items found');
  } catch (error) {
    resultsContainer.textContent = '';
    setStatus(error.message, true);
  }
}
