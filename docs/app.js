import { API_BASE } from './config.js';

const $ = (selector, root = document) => root.querySelector(selector);
const accountDialog = $('#account-dialog');
const entryDialog = $('#entry-dialog');
const accountForm = $('#account-form');
const entryForm = $('#entry-form');
const accountButton = $('#account-button');
const entriesElement = $('#entries');
const galleryState = $('#gallery-state');
const pageSize = 18;
const criteria = { wow: ['✨', 'Wow factor'], theme: ['🎯', 'Theme fit'] };
const pendingVotes = new Set();

let token = sessionStorage.getItem('avr3-session') || '';
let account = null;
let gallery = null;
let shown = pageSize;
let accountMode = 'login';
let afterLogin = null;
let galleryRequest = 0;
let votingClosed = false;

function showNotice(message) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.hidden = !message;
}

async function api(path, { method = 'GET', body, auth = token } = {}) {
  if (!API_BASE) throw new Error('Online entries will open once the competition is connected.');
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${auth}`;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`${API_BASE}/api${path}`, { method, headers, body });
  } catch {
    throw new Error('Could not reach the competition. Please try again.');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && auth && auth === token) setAccount(null);
    throw new Error(result.error || 'Something went wrong. Please try again.');
  }
  return result;
}

function setAccount(next, newToken = '') {
  account = next;
  token = newToken;
  if (token) sessionStorage.setItem('avr3-session', token);
  else sessionStorage.removeItem('avr3-session');
  accountButton.textContent = next ? 'Log out' : 'Log in';
  const name = $('#account-name');
  name.hidden = !next;
  name.textContent = next?.displayName || '';
  if (!next && gallery) {
    for (const entry of gallery.entries) {
      entry.myWow = 0;
      entry.myTheme = 0;
    }
    renderGallery();
  }
}

function make(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
}

function renderEntry(entry, rank) {
  const article = make('article', 'entry');
  article.dataset.entry = entry.id;
  if (rank <= 3 && entry.score > 0) {
    article.classList.add('podium');
    const flames = make('span', 'flames');
    flames.setAttribute('aria-hidden', 'true');
    article.append(flames);
  }
  const image = make('img');
  image.src = `${API_BASE}/api/images/${entry.id}`;
  image.alt = entry.title ? `Santa hat design: ${entry.title}` : 'Submitted Santa hat design';
  image.loading = 'lazy';
  image.decoding = 'async';
  article.append(image);
  if (entry.score > 0) {
    const badge = make('span', 'rank', `${rank <= 3 ? '🔥 ' : ''}#${rank}`);
    badge.setAttribute('aria-label', `Rank ${rank}`);
    article.append(badge);
  }
  const content = make('div', 'entry-content');
  content.append(make('h3', '', entry.title || 'Untitled design'));
  const byline = make('p', 'creator');
  byline.append(make('span', '', 'By '));
  if (account && entry.isMine && entry.displayName) {
    byline.append(make('span', '', entry.displayName));
  } else {
    const mosaic = make('span', 'creator-mosaic', 'Participant');
    mosaic.setAttribute('aria-label', 'Creator name hidden');
    byline.append(mosaic);
  }
  content.append(byline);
  if (entry.description) content.append(make('p', 'description', entry.description));

  const reactions = make('div', 'reactions');
  for (const [criterion, [icon, label]] of Object.entries(criteria)) {
    const button = make('button', 'vote', `${icon} ${entry[criterion]}`);
    button.type = 'button';
    button.dataset.vote = criterion;
    button.title = label;
    const total = entry[criterion];
    button.setAttribute('aria-label', `${label}, ${total} ${total === 1 ? 'vote' : 'votes'}`);
    button.setAttribute('aria-pressed', String(Boolean(criterion === 'wow' ? entry.myWow : entry.myTheme)));
    button.setAttribute('aria-disabled', String(votingClosed || pendingVotes.has(`${entry.id}:${criterion}`)));
    reactions.append(button);
  }
  const score = make('span', 'score', `🏆 ${entry.score}`);
  score.setAttribute('aria-label', `Total score ${entry.score}`);
  reactions.append(score);
  content.append(reactions);
  article.append(content);
  return article;
}

function renderGallery() {
  if (!gallery) return;
  votingClosed = gallery.closed;
  const sorted = $('#sort').value === 'newest'
    ? [...gallery.entries].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    : gallery.entries;
  const ranks = new Map(gallery.entries.map((entry, index) => [entry.id, index + 1]));
  const focused = document.activeElement?.closest('[data-vote]');
  const focusEntry = focused?.closest('[data-entry]')?.dataset.entry;
  const cards = sorted.slice(0, shown).map(entry => renderEntry(entry, ranks.get(entry.id) ?? Infinity));
  entriesElement.replaceChildren(...cards);
  if (focusEntry) {
    const card = cards.find(item => item.dataset.entry === focusEntry);
    const target = card && [...card.querySelectorAll('[data-vote]')].find(item => item.dataset.vote === focused.dataset.vote);
    (target || $('#sort')).focus({ preventScroll: true });
  }
  galleryState.hidden = sorted.length > 0;
  galleryState.textContent = votingClosed ? 'The competition closed without any entries.' : 'No entries yet. Be the first to share a design!';
  $('#more').hidden = shown >= sorted.length;

  const date = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', timeZone: 'Australia/Brisbane' })
    .format(gallery.closesAt);
  const score = gallery.entries[0]?.score;
  const winners = score > 0 ? gallery.entries.filter(entry => entry.score === score) : [];
  if (votingClosed && winners.length) {
    const names = winners.map(entry => entry.displayName
      ? `${entry.title || 'Untitled design'} by ${entry.displayName}`
      : entry.title || 'Untitled design');
    $('#event-date').textContent = `${names.length === 1 ? 'Winner' : 'Joint winners'}: ${new Intl.ListFormat('en-AU').format(names)}`;
  } else {
    $('#event-date').textContent = votingClosed ? 'Competition closed' : `Winner announced ${date}`;
  }
  for (const button of document.querySelectorAll('[data-submit-entry]')) {
    button.disabled = votingClosed;
    button.textContent = votingClosed ? 'Entries closed' : '＋ Submit a hat';
  }
}

async function refreshGallery(reportError = true) {
  const request = ++galleryRequest;
  const currentToken = token;
  try {
    const result = await api('/entries');
    if (request !== galleryRequest || currentToken !== token) return;
    if (JSON.stringify(result) !== JSON.stringify(gallery)) {
      gallery = result;
      renderGallery();
    }
  } catch (error) {
    if (request !== galleryRequest) return;
    if (currentToken && !token) return refreshGallery(reportError);
    if (!gallery && reportError) galleryState.textContent = error.message;
  }
}

function setAccountMode(mode) {
  accountMode = mode;
  const creating = mode === 'register';
  const title = creating ? 'Create an account' : 'Log in';
  $('#account-title').textContent = title;
  $('#account-submit').textContent = title;
  $('#account-switch').textContent = creating ? 'Already have an account? Log in' : 'Create an account';
  $('#display-field').hidden = !creating;
  $('#username-help').hidden = !creating;
  accountForm.elements.displayName.disabled = !creating;
  accountForm.elements.displayName.required = creating;
  accountForm.elements.password.autocomplete = creating ? 'new-password' : 'current-password';
  setFormError(accountForm, '');
}

function openAccount(then = null) {
  afterLogin = then;
  accountForm.reset();
  setAccountMode('login');
  accountDialog.showModal();
}

function openEntry() {
  if (votingClosed) return;
  if (!account) return openAccount(openEntry);
  setFormError(entryForm, '');
  entryDialog.showModal();
}

function setFormError(form, message) {
  const error = $('.form-error', form);
  error.textContent = message;
  error.hidden = !message;
}

async function submitForm(event, action) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type=submit]', form);
  setFormError(form, '');
  button.disabled = true;
  try {
    await action(new FormData(form));
  } catch (error) {
    setFormError(form, error.message);
  } finally {
    button.disabled = false;
  }
}

$('#account-switch').addEventListener('click', () => setAccountMode(accountMode === 'login' ? 'register' : 'login'));
accountButton.addEventListener('click', async () => {
  if (!account) return openAccount();
  accountButton.disabled = true;
  try {
    await api('/logout', { method: 'POST' });
    setAccount(null);
    refreshGallery();
  } catch (error) {
    showNotice(error.message);
  } finally {
    accountButton.disabled = false;
  }
});

accountForm.addEventListener('submit', event => submitForm(event, async data => {
  const result = await api(`/${accountMode}`, { method: 'POST', body: Object.fromEntries(data), auth: '' });
  setAccount(result.account, result.token);
  accountForm.reset();
  accountDialog.close();
  const next = afterLogin;
  afterLogin = null;
  await refreshGallery();
  if (next) next();
}));

entryForm.addEventListener('submit', event => submitForm(event, async data => {
  if (data.get('image').size > 3_000_000) throw new Error('Choose an image of 3 MB or less.');
  await api('/entries', { method: 'POST', body: data });
  entryForm.reset();
  entryDialog.close();
  $('#sort').value = 'newest';
  showNotice('Your design is in the gallery.');
  await refreshGallery();
  $('#gallery').scrollIntoView();
}));

async function vote(id, criterion) {
  if (votingClosed) return;
  const key = `${id}:${criterion}`;
  if (pendingVotes.has(key)) return;
  if (!account) return openAccount(() => vote(id, criterion));
  const current = gallery?.entries.find(entry => entry.id === id);
  if (!current) return;
  const active = !Boolean(criterion === 'wow' ? current.myWow : current.myTheme);
  pendingVotes.add(key);
  galleryRequest++;
  const updateButton = disabled => {
    entriesElement.querySelector(`[data-entry="${id}"] [data-vote="${criterion}"]`)
      ?.setAttribute('aria-disabled', String(disabled));
  };
  updateButton(true);
  try {
    await api(`/entries/${id}/votes/${criterion}`, { method: 'PUT', body: { active } });
    showNotice('');
  } catch (error) {
    showNotice(error.message);
  } finally {
    await refreshGallery();
    pendingVotes.delete(key);
    updateButton(votingClosed);
  }
}

entriesElement.addEventListener('click', event => {
  const button = event.target.closest('[data-vote]');
  if (button?.getAttribute('aria-disabled') === 'false') vote(button.closest('[data-entry]').dataset.entry, button.dataset.vote);
});
document.querySelectorAll('[data-submit-entry]').forEach(button => button.addEventListener('click', openEntry));
$('#sort').addEventListener('change', () => { shown = pageSize; renderGallery(); });
$('#more').addEventListener('click', () => { shown += pageSize; renderGallery(); });
$('nav a[href="#rules"]').addEventListener('click', () => { $('#rules').open = true; });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && API_BASE && !pendingVotes.size) refreshGallery(false);
});

async function start() {
  if (token) {
    try {
      const result = await api('/session');
      setAccount(result.account, token);
    } catch {
      setAccount(null);
    }
  }
  await refreshGallery();
  if (API_BASE) setInterval(() => {
    if (!document.hidden && !pendingVotes.size) refreshGallery(false);
  }, 15_000);
}

start();
