/* ==========================================================
   BrightEdge Task Manager - logic
   Plain JavaScript, no libraries. Data lives in localStorage.
   ========================================================== */
'use strict';

/* ---------- Settings ---------- */
const USERS_KEY = 'brightedge.users.v1';
const SESSION_KEY = 'brightedge.session.v1';
const THEME_KEY = 'brightedge.theme';
// Tasks and the tour status are saved per account (the account id is added to the end)
const TASKS_KEY_PREFIX = 'brightedge.tasks.v2.';
const TOUR_KEY_PREFIX = 'brightedge.tour.v2.';
const PRIORITIES = ['low', 'medium', 'high'];
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const TABS = ['tasks', 'dashboard', 'help'];

/* ---------- App state ---------- */
let users = [];            // all accounts saved in this browser
let currentUser = null;    // the signed-in account (or null)
let tasks = [];            // the signed-in account's tasks
let currentFilter = 'all'; // 'all' | 'active' | 'completed'
let searchQuery = '';      // lower-case search text
let sortBy = 'newest';     // 'newest' | 'oldest' | 'due' | 'priority'
let pendingAction = null;  // what to run when the confirm window is accepted
let editingId = null;      // id of the task being edited (null = adding)
let activeModal = null;    // the window currently open (or null)
let lastFocused = null;    // where to return keyboard focus after a window closes
let tourActive = false;
let tourIndex = 0;
let tourReturnFocus = null;

/* ---------- Page elements ---------- */
const $ = (id) => document.getElementById(id);

const taskList = $('task-list');
const emptyState = $('empty-state');
const clearCompletedBtn = $('clear-completed');
const searchInput = $('search-input');
const sortSelect = $('sort-select');
const filterButtons = document.querySelectorAll('.filter-btn');
const tabButtons = Array.from(document.querySelectorAll('.tab'));
const panels = { tasks: $('panel-tasks'), dashboard: $('panel-dashboard'), help: $('panel-help') };

const themeToggle = $('theme-toggle');
const themeLabel = $('theme-label');

const confirmModal = $('confirm-modal');
const confirmIcon = $('confirm-icon');
const confirmTitle = $('confirm-title');
const confirmMessage = $('confirm-message');
const confirmOk = $('confirm-ok');

const taskModal = $('task-modal');
const taskForm = $('task-form');
const taskTitle = $('task-title');
const taskDescription = $('task-description');
const taskDue = $('task-due');
const taskError = $('task-error');
const taskSubmit = $('task-submit');

const tour = $('tour');
const tourSpot = $('tour-spot');
const tourCard = $('tour-card');
const tourBack = $('tour-back');
const tourNext = $('tour-next');
const tourSkip = $('tour-skip');

/* ==========================================================
   Small helpers
   ========================================================== */

// Create an element. Text is added with textContent, so anything a user
// types is shown as plain text and can never run as HTML (safe).
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Create an icon from the icon set at the top of index.html
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function pad2(n) { return String(n).padStart(2, '0'); }

// A Date -> "YYYY-MM-DD" in the user's own timezone
function toYMD(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function todayString() { return toYMD(new Date()); }

// "2026-11-03" -> "Nov 3, 2026"
function formatDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric'
  });
}

// ISO timestamp -> "Nov 3, 2026, 4:30 PM"
function formatDateTime(iso) {
  const date = new Date(iso);
  if (isNaN(date)) return '';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// How many days from today until a YYYY-MM-DD date (negative = in the past)
function daysUntil(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const due = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

function isOverdue(task) {
  return !task.completed && task.dueDate !== '' && daysUntil(task.dueDate) < 0;
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ==========================================================
   Saving and loading (localStorage)
   ========================================================== */

function tasksKey() { return TASKS_KEY_PREFIX + currentUser.id; }
function tourKey() { return TOUR_KEY_PREFIX + currentUser.id; }

function saveTasks() {
  if (!currentUser) return;
  try {
    localStorage.setItem(tasksKey(), JSON.stringify(tasks));
  } catch (error) {
    console.warn('Could not save tasks:', error);
  }
}

// Cleans a list of tasks field by field, so bad data can never crash the app
function sanitizeTasks(data) {
  if (!Array.isArray(data)) return [];
  const seen = new Set();

  return data
    .filter((t) => t && typeof t === 'object' && String(t.title || '').trim() !== '')
    .map((t) => {
      const completed = t.completed === true;
      let id = String(t.id || makeId());
      if (seen.has(id)) id = makeId();
      seen.add(id);

      return {
        id: id,
        title: String(t.title).trim().slice(0, 100),
        description: String(t.description || '').slice(0, 500),
        dueDate: /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate) ? t.dueDate : '',
        priority: PRIORITIES.includes(t.priority) ? t.priority : 'medium',
        completed: completed,
        createdAt: String(t.createdAt || new Date().toISOString()),
        completedAt: completed ? String(t.completedAt || '') : ''
      };
    });
}

function loadTasks() {
  if (!currentUser) return [];
  try {
    const raw = localStorage.getItem(tasksKey());
    return raw ? sanitizeTasks(JSON.parse(raw)) : [];
  } catch (error) {
    console.warn('Saved data was unreadable, starting fresh:', error);
    return [];
  }
}

/* ==========================================================
   Toast messages (small notices in the corner)
   ========================================================== */

function toast(message, type) {
  type = type || 'success';
  const box = $('toasts');
  const iconName = type === 'success' ? 'check' : type === 'info' ? 'info' : 'alert';

  const node = el('div', 'toast ' + type);
  node.append(icon(iconName), el('span', '', message));
  box.append(node);

  while (box.children.length > 4) box.firstChild.remove();

  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 260);
  }, 3500);
}

/* ==========================================================
   Celebration (confetti when a task is completed)
   ========================================================== */

function confetti(x, y) {
  if (prefersReducedMotion() || !document.body.animate) return;
  const colors = ['#22d3ee', '#6b93f5', '#fbbf24', '#4ade80', '#f87171', '#a78bfa'];

  for (let i = 0; i < 28; i++) {
    const piece = el('div');
    piece.style.cssText =
      'position:fixed;z-index:400;pointer-events:none;width:8px;height:12px;border-radius:2px;' +
      'left:' + x + 'px;top:' + y + 'px;background:' + colors[i % colors.length] + ';';
    document.body.append(piece);

    const angle = Math.random() * Math.PI * 2;
    const distance = 60 + Math.random() * 130;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance - 40;
    const spin = Math.random() * 720 - 360;

    const animation = piece.animate(
      [
        { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
        { transform: 'translate(' + dx + 'px, ' + (dy + 110) + 'px) rotate(' + spin + 'deg)', opacity: 0 }
      ],
      { duration: 800 + Math.random() * 600, easing: 'cubic-bezier(.2,.7,.3,1)' }
    );
    animation.onfinish = () => piece.remove();
  }
}

function findTaskNode(id) {
  return Array.from(taskList.children).find((node) => node.dataset.id === id) || null;
}

/* ==========================================================
   Drawing the page
   ========================================================== */

function render() {
  renderHero();
  renderTasks();
  renderDashboard();
}

function counts() {
  const active = tasks.filter((t) => !t.completed).length;
  return {
    total: tasks.length,
    active: active,
    completed: tasks.length - active,
    overdue: tasks.filter(isOverdue).length
  };
}

function setRing(ring, percent) {
  ring.setAttribute('stroke-dasharray', percent + ' 100');
}

function renderHero() {
  const c = counts();
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  $('hero-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('hero-greeting').textContent = greeting + (currentUser ? ', ' + firstName(currentUser) : '') + '!';

  let summary;
  if (c.total === 0) {
    summary = 'Your task list is empty. Create your first task to get started.';
  } else if (c.active === 0) {
    summary = 'All ' + plural(c.total, 'task') + ' done. Great work!';
  } else {
    summary = 'You have ' + plural(c.active, 'active task') +
      (c.overdue > 0 ? ', and ' + c.overdue + ' ' + (c.overdue === 1 ? 'is' : 'are') + ' overdue.' : '.');
  }
  $('hero-summary').textContent = summary;

  const percent = c.total ? Math.round((c.completed / c.total) * 100) : 0;
  setRing($('hero-ring'), percent);
  $('hero-ring-text').textContent = percent + '%';

  // Tab badge shows the number of active tasks
  const badge = $('tab-badge');
  badge.textContent = c.active;
  badge.hidden = c.active === 0;
}

function sortTasks(list) {
  const byDue = (a, b) => (a.dueDate || '9999-99-99').localeCompare(b.dueDate || '9999-99-99');
  const byPriority = (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];

  const sorters = {
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
    oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
    due: (a, b) => byDue(a, b) || byPriority(a, b),
    priority: (a, b) => byPriority(a, b) || byDue(a, b)
  };
  return list.slice().sort(sorters[sortBy]);
}

function renderTasks() {
  const c = counts();

  // Numbers on the filter buttons
  document.querySelector('[data-count="all"]').textContent = c.total;
  document.querySelector('[data-count="active"]').textContent = c.active;
  document.querySelector('[data-count="completed"]').textContent = c.completed;
  filterButtons.forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.filter === currentFilter));
  });
  clearCompletedBtn.disabled = c.completed === 0;

  // Choose which tasks to show
  const visible = sortTasks(
    tasks.filter((t) => {
      if (currentFilter === 'active' && t.completed) return false;
      if (currentFilter === 'completed' && !t.completed) return false;
      if (searchQuery) {
        const text = (t.title + ' ' + t.description).toLowerCase();
        if (!text.includes(searchQuery)) return false;
      }
      return true;
    })
  );

  taskList.replaceChildren(...visible.map(createTaskItem));

  // Friendly message when there is nothing to show
  emptyState.hidden = visible.length > 0;
  if (visible.length === 0) {
    let title, text;
    if (c.total === 0) {
      title = 'No tasks yet';
      text = 'Create your first task and start getting organised.';
    } else if (searchQuery) {
      title = 'No matching tasks';
      text = 'Try a different search word or change the filter.';
    } else if (currentFilter === 'active') {
      title = 'Nothing active';
      text = 'You are all caught up. Nice work!';
    } else {
      title = 'No completed tasks';
      text = 'Tasks you finish will appear here.';
    }
    $('empty-title').textContent = title;
    $('empty-text').textContent = text;
  }
}

function dueLabel(task) {
  const diff = daysUntil(task.dueDate);
  const date = formatDate(task.dueDate);
  if (task.completed) return 'Due ' + date;
  if (diff < 0) return 'Overdue by ' + plural(-diff, 'day') + ' \u00B7 ' + date;
  if (diff === 0) return 'Due today';
  if (diff === 1) return 'Due tomorrow';
  return 'Due in ' + plural(diff, 'day') + ' \u00B7 ' + date;
}

function makeChip(iconName, text, extraClass) {
  const chip = el('span', 'chip' + (extraClass ? ' ' + extraClass : ''));
  chip.append(icon(iconName), document.createTextNode(text));
  return chip;
}

function makeIconButton(iconName, label, action, taskTitle, extraClass) {
  const btn = el('button', 'icon-btn' + (extraClass ? ' ' + extraClass : ''));
  btn.type = 'button';
  btn.dataset.action = action;
  btn.title = label;
  btn.setAttribute('aria-label', label + ': ' + taskTitle);
  btn.append(icon(iconName));
  return btn;
}

function createTaskItem(task) {
  const overdue = isOverdue(task);

  const item = el('li', 'task p-' + task.priority);
  item.dataset.id = task.id;
  if (task.completed) item.classList.add('completed');
  if (overdue) item.classList.add('overdue');

  // Round "complete" button on the left
  const check = el('button', 'check-btn' + (task.completed ? ' done' : ''));
  check.type = 'button';
  check.append(icon('check'));
  if (task.completed) {
    check.disabled = true;
    check.setAttribute('aria-label', 'Completed: ' + task.title);
  } else {
    check.dataset.action = 'complete';
    check.title = 'Mark as complete';
    check.setAttribute('aria-label', 'Mark complete: ' + task.title);
  }

  // Middle: title, description, chips
  const main = el('div', 'task-main');
  main.append(el('h3', 'task-title', task.title));
  if (task.description) main.append(el('p', 'task-desc', task.description));

  const chips = el('div', 'chips');
  chips.append(makeChip('flag', capitalize(task.priority) + ' priority', 'chip-' + task.priority));
  if (task.dueDate) {
    const dueClass = overdue ? 'chip-overdue' : (!task.completed && daysUntil(task.dueDate) === 0 ? 'chip-today' : '');
    chips.append(makeChip(overdue ? 'alert' : 'calendar', dueLabel(task), dueClass));
  }
  chips.append(makeChip('clock', 'Created ' + formatDateTime(task.createdAt)));
  if (task.completed && task.completedAt) {
    chips.append(makeChip('check', 'Completed ' + formatDateTime(task.completedAt), 'chip-done'));
  }
  main.append(chips);

  // Right: edit and delete
  const actions = el('div', 'task-actions');
  if (!task.completed) actions.append(makeIconButton('edit', 'Edit', 'edit', task.title));
  actions.append(makeIconButton('trash', 'Delete', 'delete', task.title, 'danger'));

  item.append(check, main, actions);
  return item;
}

/* ---------- Dashboard ---------- */

function miniItem(title, chip) {
  const li = el('li', 'mini-item');
  li.append(el('span', 'mini-title', title), chip);
  return li;
}

function fillMiniList(listEl, items, emptyText) {
  if (items.length === 0) {
    listEl.replaceChildren(el('li', 'mini-empty', emptyText));
  } else {
    listEl.replaceChildren(...items);
  }
}

function renderDashboard() {
  const c = counts();

  $('stat-total').textContent = c.total;
  $('stat-active').textContent = c.active;
  $('stat-completed').textContent = c.completed;
  $('stat-overdue').textContent = c.overdue;

  // Completion ring
  const percent = c.total ? Math.round((c.completed / c.total) * 100) : 0;
  setRing($('big-ring'), percent);
  $('big-ring-text').textContent = percent + '%';
  $('ring-caption').textContent = c.total
    ? c.completed + ' of ' + plural(c.total, 'task') + ' completed.'
    : 'Add tasks to see your progress.';

  // Active tasks by priority
  PRIORITIES.forEach((level) => {
    const count = tasks.filter((t) => !t.completed && t.priority === level).length;
    const row = document.querySelector('.bar-row[data-priority="' + level + '"]');
    row.querySelector('.bar-fill').style.width = (c.active ? (count / c.active) * 100 : 0) + '%';
    row.querySelector('.bar-count').textContent = count;
  });

  // Needs attention: overdue or due within 7 days
  const attention = tasks
    .filter((t) => !t.completed && t.dueDate && daysUntil(t.dueDate) <= 7)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 6)
    .map((t) => {
      const cls = isOverdue(t) ? 'chip-overdue' : daysUntil(t.dueDate) === 0 ? 'chip-today' : '';
      return miniItem(t.title, makeChip(isOverdue(t) ? 'alert' : 'calendar', dueLabel(t), cls));
    });
  fillMiniList($('due-soon-list'), attention, 'Nothing is due in the next 7 days.');

  // Recently completed
  const recent = tasks
    .filter((t) => t.completed)
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
    .slice(0, 5)
    .map((t) => miniItem(t.title, makeChip('check', formatDateTime(t.completedAt), 'chip-done')));
  fillMiniList($('recent-list'), recent, 'No completed tasks yet.');
}

/* ==========================================================
   Tabs (Tasks, Dashboard, Help)
   ========================================================== */

function readHash() {
  const name = location.hash.replace('#', '');
  return TABS.includes(name) ? name : 'tasks';
}

function showTab(name) {
  tabButtons.forEach((btn) => {
    const selected = btn.dataset.tab === name;
    btn.setAttribute('aria-selected', String(selected));
    btn.tabIndex = selected ? 0 : -1;
  });
  TABS.forEach((tab) => { panels[tab].hidden = tab !== name; });
}

function goTab(name) {
  if (location.hash !== '#' + name) location.hash = name;
  showTab(name);
}

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => goTab(btn.dataset.tab));
});

// Arrow keys move between tabs
document.querySelector('.tabs').addEventListener('keydown', (event) => {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  event.preventDefault();

  const current = tabButtons.findIndex((b) => b.getAttribute('aria-selected') === 'true');
  let next = current;
  if (event.key === 'ArrowRight') next = (current + 1) % tabButtons.length;
  if (event.key === 'ArrowLeft') next = (current - 1 + tabButtons.length) % tabButtons.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = tabButtons.length - 1;

  goTab(tabButtons[next].dataset.tab);
  tabButtons[next].focus();
});

window.addEventListener('hashchange', () => showTab(readHash()));

/* ---------- Footer links and year ---------- */

$('footer-year').textContent = new Date().getFullYear();

document.querySelectorAll('.footer-link').forEach((btn) => {
  btn.addEventListener('click', () => {
    goTab(btn.dataset.goto);

    // A link can also scroll to a part of the page (e.g. the shortcuts list)
    const target = btn.dataset.scroll ? $(btn.dataset.scroll) : null;
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (target) {
      requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
      });
    }
  });
});

/* ==========================================================
   Windows (modals): one function opens, one closes
   ========================================================== */

function getFocusable(container) {
  return Array.from(
    container.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')
  ).filter((node) => !node.disabled && node.getClientRects().length > 0);
}

function openModal(modal, firstFocus) {
  lastFocused = document.activeElement;
  activeModal = modal;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  (firstFocus || getFocusable(modal)[0]).focus();
}

function closeModal() {
  if (!activeModal) return;
  activeModal.hidden = true;
  activeModal = null;
  pendingAction = null;
  editingId = null;
  document.body.classList.remove('modal-open');
  if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
}

// Ask "Are you sure?" and run onConfirm only if the user accepts
function askConfirm(options, onConfirm) {
  confirmTitle.textContent = options.title;
  confirmMessage.textContent = options.message;
  confirmOk.textContent = options.confirmText;
  confirmOk.className = 'btn ' + (options.danger ? 'btn-danger' : 'btn-primary');
  confirmIcon.className = 'confirm-icon' + (options.danger ? ' danger' : '');
  confirmIcon.querySelector('use').setAttribute('href', options.danger ? '#i-alert' : '#i-info');
  pendingAction = onConfirm;
  openModal(confirmModal, confirmOk);
}

confirmOk.addEventListener('click', () => {
  const action = pendingAction;
  closeModal();
  if (action) action();
});

document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', closeModal);
});

// Clicking the dark backdrop closes the window
document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) closeModal();
  });
});

/* ==========================================================
   Add / edit task
   ========================================================== */

function showError(message) {
  taskError.textContent = message;
  taskError.hidden = false;
  taskTitle.setAttribute('aria-invalid', 'true');
  taskTitle.focus();
}

function clearError() {
  taskError.hidden = true;
  taskError.textContent = '';
  taskTitle.removeAttribute('aria-invalid');
}

function openTaskModal(task) {
  editingId = task ? task.id : null;

  $('task-modal-title').textContent = task ? 'Edit task' : 'New task';
  $('task-modal-sub').textContent = task ? 'Update the details and save.' : 'Fill in the details below.';
  taskSubmit.textContent = task ? 'Save changes' : 'Add task';

  taskTitle.value = task ? task.title : '';
  taskDescription.value = task ? task.description : '';
  taskDue.value = task ? task.dueDate : '';
  taskForm.querySelector('input[name="priority"][value="' + (task ? task.priority : 'medium') + '"]').checked = true;

  clearError();
  openModal(taskModal, taskTitle);
}

taskForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const title = taskTitle.value.trim();
  if (!title) {
    showError('Please enter a task title.');
    return;
  }

  const description = taskDescription.value.trim();
  const dueDate = taskDue.value;
  const priority = taskForm.querySelector('input[name="priority"]:checked').value;
  const id = editingId;

  if (id) {
    const task = tasks.find((t) => t.id === id);
    if (!task || task.completed) { // completed tasks are final
      closeModal();
      return;
    }
    task.title = title;
    task.description = description;
    task.dueDate = dueDate;
    task.priority = priority;
    toast('Task updated');
  } else {
    tasks.unshift({
      id: makeId(),
      title: title,
      description: description,
      dueDate: dueDate,
      priority: priority,
      completed: false,
      createdAt: new Date().toISOString(),
      completedAt: ''
    });
    if (currentFilter === 'completed') currentFilter = 'all'; // make sure the new task is visible
    toast('Task added');
  }

  saveTasks();
  closeModal();
  render();
});

taskTitle.addEventListener('input', clearError);

// "Today", "Tomorrow", "In 1 week" buttons
document.querySelectorAll('[data-due-offset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const date = new Date();
    date.setDate(date.getDate() + Number(btn.dataset.dueOffset));
    taskDue.value = toYMD(date);
  });
});

$('new-task-btn').addEventListener('click', () => openTaskModal(null));
$('empty-new-btn').addEventListener('click', () => openTaskModal(null));

/* ==========================================================
   Task actions: complete, edit, delete, clear
   ========================================================== */

taskList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const id = button.closest('.task').dataset.id;
  const task = tasks.find((t) => t.id === id);
  if (!task) return;

  if (button.dataset.action === 'complete') confirmComplete(task);
  if (button.dataset.action === 'edit' && !task.completed) openTaskModal(task);
  if (button.dataset.action === 'delete') confirmDelete(task);
});

function confirmComplete(task) {
  if (task.completed) return;
  askConfirm(
    {
      title: 'Mark task as completed?',
      message: 'Are you sure you want to continue? Completed tasks can no longer be edited.',
      confirmText: 'Confirm'
    },
    () => {
      task.completed = true;
      task.completedAt = new Date().toISOString();
      saveTasks();
      render();
      toast('Task completed. Well done!');

      // Confetti from the task card (or the top of the screen if it is hidden by a filter)
      const node = findTaskNode(task.id);
      if (node) {
        const rect = node.getBoundingClientRect();
        confetti(rect.left + 30, rect.top + rect.height / 2);
      } else {
        confetti(window.innerWidth / 2, window.innerHeight / 3);
      }
    }
  );
}

function confirmDelete(task) {
  askConfirm(
    {
      title: 'Delete this task?',
      message: 'This will permanently remove the task. This cannot be undone.',
      confirmText: 'Delete',
      danger: true
    },
    () => {
      tasks = tasks.filter((t) => t.id !== task.id);
      saveTasks();
      render();
      toast('Task deleted', 'info');
    }
  );
}

clearCompletedBtn.addEventListener('click', () => {
  const count = tasks.filter((t) => t.completed).length;
  if (count === 0) return;

  askConfirm(
    {
      title: 'Clear completed tasks?',
      message: 'This will permanently remove ' + plural(count, 'completed task') + '.',
      confirmText: 'Clear all',
      danger: true
    },
    () => {
      tasks = tasks.filter((t) => !t.completed);
      saveTasks();
      render();
      toast('Completed tasks cleared', 'info');
    }
  );
});

/* ---------- Search, sort, filters ---------- */

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value.trim().toLowerCase();
  renderTasks();
});

searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && searchInput.value) {
    searchInput.value = '';
    searchQuery = '';
    renderTasks();
  }
});

sortSelect.addEventListener('change', () => {
  sortBy = sortSelect.value;
  renderTasks();
});

filterButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    currentFilter = btn.dataset.filter;
    renderTasks();
  });
});

/* ==========================================================
   Backup, restore and reset (on the Help tab)
   ========================================================== */

$('export-btn').addEventListener('click', () => {
  if (tasks.length === 0) {
    toast('You have no tasks to back up yet.', 'warn');
    return;
  }
  const backup = {
    app: 'BrightEdge Task Manager',
    version: 1,
    exportedAt: new Date().toISOString(),
    tasks: tasks
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'brightedge-tasks-' + todayString() + '.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Backup downloaded');
});

$('import-btn').addEventListener('click', () => $('import-file').click());

$('import-file').addEventListener('change', (event) => {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    input.value = ''; // lets the same file be chosen again later
    try {
      const data = JSON.parse(reader.result);
      const list = Array.isArray(data) ? data : data && data.tasks;
      const imported = sanitizeTasks(list);

      if (!Array.isArray(list) || (list.length > 0 && imported.length === 0)) {
        toast('That file does not look like a BrightEdge backup.', 'error');
        return;
      }

      askConfirm(
        {
          title: 'Restore from backup?',
          message: 'This replaces your current tasks with ' + plural(imported.length, 'task') + ' from the file.',
          confirmText: 'Restore'
        },
        () => {
          tasks = imported;
          saveTasks();
          render();
          toast('Backup restored');
        }
      );
    } catch (error) {
      toast('That file could not be read.', 'error');
    }
  };
  reader.onerror = () => toast('That file could not be read.', 'error');
  reader.readAsText(file);
});

$('reset-btn').addEventListener('click', () => {
  if (tasks.length === 0) {
    toast('There are no tasks to delete.', 'info');
    return;
  }
  askConfirm(
    {
      title: 'Delete all tasks?',
      message: 'This permanently removes all ' + plural(tasks.length, 'task') + '. Download a backup first if you might need them.',
      confirmText: 'Delete everything',
      danger: true
    },
    () => {
      tasks = [];
      saveTasks();
      render();
      toast('All tasks deleted', 'info');
    }
  );
});

/* ==========================================================
   Dark mode
   ========================================================== */

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const isDark = theme === 'dark';
  themeLabel.textContent = isDark ? 'Light' : 'Dark';
  themeToggle.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
}

function loadTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch (error) {
    saved = null;
  }
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

themeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (error) {
    console.warn('Could not save theme:', error);
  }
});

/* ==========================================================
   Welcome tour
   ========================================================== */

// To change the tour, edit this list. "target" is a CSS selector for the
// part of the page to highlight. Steps with no target appear in the middle.
const TOUR_STEPS = [
  {
    title: 'Welcome to BrightEdge Task Manager',
    text: 'Take a one-minute tour of the main features. You can skip at any time and replay it later from the Help tab.'
  },
  {
    target: '#new-task-btn',
    title: 'Create tasks',
    text: 'Click New task (or press N) to add a task with a title, description, due date and priority.'
  },
  {
    target: '#task-toolbar',
    title: 'Find tasks fast',
    text: 'Search by word, sort by due date or priority, and filter between All, Active and Completed.'
  },
  {
    target: '#task-list .task, #empty-state',
    title: 'Complete, edit or delete',
    text: 'The round button marks a task complete (you will be asked to confirm). The pencil edits it and the bin deletes it. Completed tasks are locked.'
  },
  {
    target: '#tab-dashboard',
    title: 'See your progress',
    text: 'The Dashboard shows totals, your completion rate, priorities and tasks that need attention.'
  },
  {
    target: '#tab-help',
    title: 'Help is always here',
    text: 'The Help tab has a full guide, keyboard shortcuts, and backup and restore for your data.'
  },
  {
    target: '#theme-toggle',
    title: 'Light or dark',
    text: 'Switch between light and dark mode whenever you like. Your choice is remembered.'
  },
  {
    target: '#account-btn',
    title: 'Your account',
    text: 'Click your avatar to change your password or delete your account. The arrow button next to it logs you out.'
  },
  {
    title: "You're all set!",
    text: 'Press ? at any time to open Help. Enjoy staying organised.'
  }
];

function isVisible(node) {
  return node && node.getClientRects().length > 0;
}

function startTour() {
  if (tourActive || !currentUser) return;
  goTab('tasks');
  tourActive = true;
  tourReturnFocus = document.activeElement;
  tour.hidden = false;
  document.body.classList.add('modal-open');
  showTourStep(0);
}

function endTour() {
  if (!tourActive) return;
  tourActive = false;
  tour.hidden = true;
  document.body.classList.remove('modal-open');
  try {
    localStorage.setItem(tourKey(), 'done');
  } catch (error) {
    console.warn('Could not save tour status:', error);
  }
  if (tourReturnFocus && document.contains(tourReturnFocus)) tourReturnFocus.focus();
}

function showTourStep(index) {
  tourIndex = index;
  const step = TOUR_STEPS[index];
  const last = index === TOUR_STEPS.length - 1;

  $('tour-step').textContent = 'Step ' + (index + 1) + ' of ' + TOUR_STEPS.length;
  $('tour-title').textContent = step.title;
  $('tour-text').textContent = step.text;
  tourBack.hidden = index === 0;
  tourSkip.hidden = last;
  tourNext.textContent = last ? 'Get started' : 'Next';

  const dots = $('tour-dots');
  dots.replaceChildren(...TOUR_STEPS.map((s, i) => el('span', i === index ? 'on' : '')));

  const target = step.target ? document.querySelector(step.target) : null;
  const usable = isVisible(target) ? target : null;
  if (usable) usable.scrollIntoView({ block: 'center', inline: 'nearest' });

  requestAnimationFrame(() => positionTour(usable));
  tourNext.focus();
}

function positionTour(target) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardW = tourCard.offsetWidth;
  const cardH = tourCard.offsetHeight;
  const gap = 14;
  const pad = 8;
  let left, top;

  if (!target) {
    // Centered step: a zero-size spotlight in the middle still dims the page
    tourSpot.style.cssText = 'left:' + vw / 2 + 'px;top:' + vh / 2 + 'px;width:0;height:0;';
    left = (vw - cardW) / 2;
    top = (vh - cardH) / 2;
  } else {
    const r = target.getBoundingClientRect();
    tourSpot.style.cssText =
      'left:' + (r.left - pad) + 'px;top:' + (r.top - pad) + 'px;' +
      'width:' + (r.width + pad * 2) + 'px;height:' + (r.height + pad * 2) + 'px;';

    if (r.bottom + pad + gap + cardH <= vh - 12) top = r.bottom + pad + gap;
    else if (r.top - pad - gap - cardH >= 12) top = r.top - pad - gap - cardH;
    else top = Math.max(12, (vh - cardH) / 2);

    left = Math.min(Math.max(r.left, 12), vw - cardW - 12);
  }

  tourCard.style.left = Math.max(12, left) + 'px';
  tourCard.style.top = Math.max(12, top) + 'px';
}

function tourNextStep() {
  if (tourIndex >= TOUR_STEPS.length - 1) endTour();
  else showTourStep(tourIndex + 1);
}

function tourPrevStep() {
  if (tourIndex > 0) showTourStep(tourIndex - 1);
}

tourNext.addEventListener('click', tourNextStep);
tourBack.addEventListener('click', tourPrevStep);
tourSkip.addEventListener('click', endTour);
$('replay-tour').addEventListener('click', startTour);
window.addEventListener('resize', () => {
  if (tourActive) showTourStep(tourIndex);
});

function tourWasSeen() {
  try {
    return localStorage.getItem(tourKey()) === 'done';
  } catch (error) {
    return false;
  }
}

/* ==========================================================
   Keyboard: Escape, Tab trapping and shortcuts
   ========================================================== */

// Keep Tab inside a window
function trapTab(event, container) {
  const focusable = getFocusable(container);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

document.addEventListener('keydown', (event) => {
  // 1. Welcome tour
  if (tourActive) {
    if (event.key === 'Escape') endTour();
    else if (event.key === 'ArrowRight') tourNextStep();
    else if (event.key === 'ArrowLeft') tourPrevStep();
    else if (event.key === 'Tab') trapTab(event, tourCard);
    return;
  }

  // 2. Open windows
  if (activeModal) {
    if (event.key === 'Escape') closeModal();
    else if (event.key === 'Tab') trapTab(event, activeModal);
    return;
  }

  // 3. Shortcuts (only when signed in, not while typing, and not with Ctrl / Alt / Cmd)
  if (!currentUser) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const tag = event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target.isContentEditable) return;

  if (event.key === 'n' || event.key === 'N') {
    event.preventDefault();
    goTab('tasks');
    openTaskModal(null);
  } else if (event.key === '/') {
    event.preventDefault();
    goTab('tasks');
    searchInput.focus();
  } else if (event.key === '?') {
    goTab('help');
  } else if (event.key === '1') {
    goTab('tasks');
  } else if (event.key === '2') {
    goTab('dashboard');
  } else if (event.key === '3') {
    goTab('help');
  }
});

/* ==========================================================
   Accounts (demo login)
   Accounts live in this browser only. Passwords are never saved as
   plain text: they are scrambled with PBKDF2 and a random salt.
   This is a prototype, not real security.
   ========================================================== */

const AVATAR_COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#059669', '#0891b2'];
const CRYPTO_MESSAGE = 'This browser cannot create secure accounts here. Try Chrome, Edge or Firefox.';

const appShell = $('app');
const authScreen = $('auth-screen');
const loginForm = $('login-form');
const signupForm = $('signup-form');
const accountModal = $('account-modal');
const passwordForm = $('password-form');
const deleteForm = $('delete-form');

/* ---------- Helpers ---------- */

function cryptoAvailable() {
  return !!(window.crypto && window.crypto.subtle && window.crypto.getRandomValues && window.TextEncoder);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomSalt() {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

// Scrambles a password with the salt (PBKDF2, 150,000 rounds)
async function hashPassword(password, saltHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await window.crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt, iterations: 150000, hash: 'SHA-256' },
    key,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

// Compares two texts without stopping at the first difference
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function passwordProblem(password) {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must include at least one letter and one number.';
  return '';
}

function firstName(user) {
  return user.name.split(/\s+/)[0];
}

function initials(name) {
  const words = name.trim().split(/\s+/);
  const letters = words[0].charAt(0) + (words.length > 1 ? words[words.length - 1].charAt(0) : '');
  return letters.toUpperCase();
}

function fillAvatar(node, user) {
  let sum = 0;
  for (const ch of user.id) sum += ch.charCodeAt(0);
  node.textContent = initials(user.name);
  node.style.background = AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

function showMessage(box, text, kind) {
  box.textContent = text;
  box.hidden = false;
  if (kind) box.className = kind;
}

function hideMessage(box) {
  box.hidden = true;
  box.textContent = '';
}

function setBusy(button, busy, busyText) {
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyText;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
  button.disabled = busy;
}

/* ---------- Saving accounts and the signed-in session ---------- */

function loadUsers() {
  try {
    const data = JSON.parse(localStorage.getItem(USERS_KEY) || '[]');
    if (!Array.isArray(data)) return [];
    return data
      .filter((u) => u && typeof u === 'object' && u.id && u.name && u.email && u.salt && u.hash)
      .map((u) => ({
        id: String(u.id),
        name: String(u.name).slice(0, 40),
        email: String(u.email).toLowerCase(),
        salt: String(u.salt),
        hash: String(u.hash),
        createdAt: String(u.createdAt || new Date().toISOString())
      }));
  } catch (error) {
    console.warn('Saved accounts were unreadable:', error);
    return [];
  }
}

function saveUsers() {
  try {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
    return true;
  } catch (error) {
    console.warn('Could not save accounts:', error);
    return false;
  }
}

// "Remember me" keeps the session after the browser closes; otherwise it lasts until the tab closes
function startSession(user, remember) {
  clearSession();
  try {
    (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, user.id);
  } catch (error) {
    console.warn('Could not save the session:', error);
  }
}

function readSession() {
  try {
    return sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
  } catch (error) {
    return null;
  }
}

function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY);
  } catch (error) {
    /* nothing to clear */
  }
}

/* ---------- Switching between the login screen and the app ---------- */

function setAuthMode(mode) {
  document.querySelectorAll('.auth-tab').forEach((btn) => {
    const on = btn.dataset.authTab === mode;
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
  });
  loginForm.hidden = mode !== 'login';
  signupForm.hidden = mode !== 'signup';
  hideMessage($('login-error'));
  hideMessage($('signup-error'));
  (mode === 'login' ? $('login-email') : $('signup-name')).focus();
}

function showAuth() {
  appShell.hidden = true;
  authScreen.hidden = false;
  [loginForm, signupForm].forEach((form) => form.reset());
  document.querySelectorAll('#auth-screen input[data-pw]').forEach((input) => { input.type = 'password'; });
  setAuthMode(users.length > 0 ? 'login' : 'signup');
}

function enterApp(user) {
  currentUser = user;
  tasks = loadTasks();

  // Start with a clean view for this account
  currentFilter = 'all';
  searchQuery = '';
  sortBy = 'newest';
  searchInput.value = '';
  sortSelect.value = 'newest';

  fillAvatar($('header-avatar'), user);
  $('header-name').textContent = firstName(user);

  authScreen.hidden = true;
  appShell.hidden = false;
  showTab(readHash());
  render();
  window.scrollTo(0, 0);

  if (!tourWasSeen()) setTimeout(startTour, 500);
}

function logout(message) {
  if (tourActive) {
    tourActive = false;
    tour.hidden = true;
  }
  closeModal();
  document.body.classList.remove('modal-open');
  clearSession();
  currentUser = null;
  tasks = [];
  showAuth();
  if (message) toast(message, 'info');
}

document.querySelectorAll('.auth-tab').forEach((btn) => {
  btn.addEventListener('click', () => setAuthMode(btn.dataset.authTab));
});
document.querySelectorAll('[data-auth-switch]').forEach((btn) => {
  btn.addEventListener('click', () => setAuthMode(btn.dataset.authSwitch));
});

// "Show password" checkboxes
document.querySelectorAll('[data-show-passwords]').forEach((box) => {
  box.addEventListener('change', () => {
    box.closest('form').querySelectorAll('input[data-pw]').forEach((input) => {
      input.type = box.checked ? 'text' : 'password';
    });
  });
});

/* ---------- Log in ---------- */

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorBox = $('login-error');
  const email = $('login-email').value.trim().toLowerCase();
  const password = $('login-password').value;
  hideMessage(errorBox);

  if (!validEmail(email) || !password) {
    showMessage(errorBox, 'Please enter your email and password.');
    return;
  }
  if (!cryptoAvailable()) {
    showMessage(errorBox, CRYPTO_MESSAGE);
    return;
  }

  const button = loginForm.querySelector('button[type="submit"]');
  setBusy(button, true, 'Signing in...');
  try {
    const user = users.find((u) => u.email === email);
    // Always do the same work, so the answer takes the same time for unknown emails
    const hash = await hashPassword(password, user ? user.salt : '00000000000000000000000000000000');

    if (!user || !sameText(hash, user.hash)) {
      showMessage(errorBox, 'Incorrect email or password.');
      return;
    }
    startSession(user, $('login-remember').checked);
    loginForm.reset();
    enterApp(user);
    toast('Welcome back, ' + firstName(user) + '!');
  } catch (error) {
    console.warn('Login failed:', error);
    showMessage(errorBox, 'Something went wrong. Please try again.');
  } finally {
    setBusy(button, false);
  }
});

/* ---------- Create account ---------- */

signupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorBox = $('signup-error');
  const name = $('signup-name').value.trim().replace(/\s+/g, ' ');
  const email = $('signup-email').value.trim().toLowerCase();
  const password = $('signup-password').value;
  const confirm = $('signup-confirm').value;
  hideMessage(errorBox);

  let problem = '';
  if (name.length < 2) problem = 'Please enter your full name.';
  else if (!validEmail(email)) problem = 'Please enter a valid email address.';
  else if (users.some((u) => u.email === email)) problem = 'An account with this email already exists. Try logging in.';
  else problem = passwordProblem(password);
  if (!problem && password !== confirm) problem = 'The passwords do not match.';
  if (!problem && !cryptoAvailable()) problem = CRYPTO_MESSAGE;

  if (problem) {
    showMessage(errorBox, problem);
    return;
  }

  const button = signupForm.querySelector('button[type="submit"]');
  setBusy(button, true, 'Creating account...');
  try {
    const salt = randomSalt();
    const user = {
      id: makeId(),
      name: name,
      email: email,
      salt: salt,
      hash: await hashPassword(password, salt),
      createdAt: new Date().toISOString()
    };

    users.push(user);
    if (!saveUsers()) {
      users.pop();
      showMessage(errorBox, 'Could not save your account. Check that your browser allows site storage.');
      return;
    }
    startSession(user, $('signup-remember').checked);
    signupForm.reset();
    enterApp(user);
    toast('Account created. Welcome, ' + firstName(user) + '!');
  } catch (error) {
    console.warn('Sign up failed:', error);
    showMessage(errorBox, 'Something went wrong. Please try again.');
  } finally {
    setBusy(button, false);
  }
});

/* ---------- Account window: change password, delete account ---------- */

function openAccountModal() {
  fillAvatar($('account-avatar'), currentUser);
  $('account-name').textContent = currentUser.name;
  $('account-email').textContent = currentUser.email;
  $('account-since').textContent = 'Member since ' + formatDate(toYMD(new Date(currentUser.createdAt)));

  [passwordForm, deleteForm].forEach((form) => form.reset());
  accountModal.querySelectorAll('input[data-pw]').forEach((input) => { input.type = 'password'; });
  hideMessage($('pw-message'));
  hideMessage($('delete-error'));
  openModal(accountModal, $('pw-current'));
}

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('pw-message');
  const current = $('pw-current').value;
  const next = $('pw-new').value;
  const confirm = $('pw-confirm').value;
  hideMessage(message);

  if (!current) return showMessage(message, 'Please enter your current password.', 'error');
  if (!cryptoAvailable()) return showMessage(message, CRYPTO_MESSAGE, 'error');

  const button = passwordForm.querySelector('button[type="submit"]');
  setBusy(button, true, 'Updating...');
  try {
    const currentHash = await hashPassword(current, currentUser.salt);
    if (!sameText(currentHash, currentUser.hash)) {
      return showMessage(message, 'Your current password is not correct.', 'error');
    }
    const problem = passwordProblem(next);
    if (problem) return showMessage(message, problem, 'error');
    if (next !== confirm) return showMessage(message, 'The new passwords do not match.', 'error');
    if (next === current) return showMessage(message, 'Please choose a different password from your current one.', 'error');

    const oldSalt = currentUser.salt;
    const oldHash = currentUser.hash;
    currentUser.salt = randomSalt();
    currentUser.hash = await hashPassword(next, currentUser.salt);
    if (!saveUsers()) {
      currentUser.salt = oldSalt;
      currentUser.hash = oldHash;
      return showMessage(message, 'Could not save the new password. Check that your browser allows site storage.', 'error');
    }
    passwordForm.reset();
    showMessage(message, 'Password updated.', 'success');
    toast('Password updated');
  } catch (error) {
    console.warn('Password change failed:', error);
    showMessage(message, 'Something went wrong. Please try again.', 'error');
  } finally {
    setBusy(button, false);
  }
});

deleteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorBox = $('delete-error');
  const password = $('delete-password').value;
  hideMessage(errorBox);

  if (!password) return showMessage(errorBox, 'Please enter your password.');
  if (!cryptoAvailable()) return showMessage(errorBox, CRYPTO_MESSAGE);

  const button = deleteForm.querySelector('button[type="submit"]');
  setBusy(button, true, 'Checking...');
  let correct = false;
  try {
    correct = sameText(await hashPassword(password, currentUser.salt), currentUser.hash);
  } catch (error) {
    console.warn('Password check failed:', error);
  } finally {
    setBusy(button, false);
  }
  if (!correct) return showMessage(errorBox, 'That password is not correct.');

  // Password is right: ask one last time
  const doomed = currentUser;
  closeModal();
  askConfirm(
    {
      title: 'Delete your account?',
      message: 'This permanently deletes your account and all ' + plural(tasks.length, 'task') + '. This cannot be undone.',
      confirmText: 'Delete account',
      danger: true
    },
    () => {
      users = users.filter((u) => u.id !== doomed.id);
      saveUsers();
      try {
        localStorage.removeItem(TASKS_KEY_PREFIX + doomed.id);
        localStorage.removeItem(TOUR_KEY_PREFIX + doomed.id);
      } catch (error) {
        console.warn('Could not remove saved tasks:', error);
      }
      logout('Your account has been deleted.');
    }
  );
});

$('account-btn').addEventListener('click', openAccountModal);
$('logout-btn').addEventListener('click', () => logout('You have been signed out.'));

/* ==========================================================
   Start the app
   ========================================================== */

applyTheme(loadTheme());
users = loadUsers();

// Already signed in (Remember me)? Go straight to the app. Otherwise show the login screen.
const savedUser = users.find((u) => u.id === readSession());
if (savedUser) enterApp(savedUser);
else showAuth();