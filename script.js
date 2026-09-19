"use strict";

/* =====================================================
   ZeroDay
   Activities (recurring, reset daily) + To-Dos (carry over)
   Vanilla JS + localStorage + PWA
   ===================================================== */

/* ---------- CONSTANTS ---------- */
const KEYS = {
  activities: "activities",
  todos: "todos",
  settings: "settings",
  notifState: "notifState",
  lastDate: "lastDate",
  legacy: "items" // single-list key used by the earliest version
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TYPES = ["daily", "alternate", "specific"];

const OUTER_C = 2 * Math.PI * 54; // activity ring circumference
const INNER_C = 2 * Math.PI * 40; // to-do ring circumference

const OPEN_X = 80;            // where a row rests when Delete is revealed
const OPEN_TRIGGER = 60;      // drag right past this to reveal Delete
const COMPLETE_TRIGGER = 80;  // drag left past this to complete / undo
const MAX_DRAG = 140;         // rubber-band starts here
const LONG_PRESS_MS = 480;    // hold this long to edit

/* Priority = importance + urgency (1-3 stars each)
   2-3 -> low (green) | 4 -> medium (yellow) | 5-6 -> high (red) */
const PRIORITY = {
  high:   { label: "High priority",   rank: 0 },
  medium: { label: "Medium priority", rank: 1 },
  low:    { label: "Low priority",    rank: 2 }
};

/* Reminder intensity: how often, and how it feels */
const LEVELS = {
  low:    { label: "Low",    every: 120, freq: "Every 2 hours",   feel: "gentle buzz",                          vibrate: [120],                     sticky: false },
  medium: { label: "Medium", every: 60,  freq: "Every hour",      feel: "double buzz",                          vibrate: [150, 80, 150],            sticky: false },
  high:   { label: "High",   every: 20,  freq: "Every 20 minutes", feel: "strong buzz, stays until dismissed",  vibrate: [250, 100, 250, 100, 500], sticky: true }
};
const LEVEL_KEYS = ["low", "medium", "high"];

const DEFAULT_REMINDER = { on: false, from: "09:00", to: "21:00", level: "medium" };

/* ---------- ELEMENTS ---------- */
const $ = (id) => document.getElementById(id);

const activityList = $("activityList");
const todoList = $("todoList");
const activityRing = $("activityRing");
const todoRing = $("todoRing");
const progressText = $("progressText");
const progressWrapper = $("progressWrapper");
const legendActivity = $("legendActivity");
const legendTodo = $("legendTodo");
const todoCount = $("todoCount");

const activityHead = $("activityHead");
const reorderBtn = $("reorderBtn");

const priorityPanel = $("priorityPanel");
const priorityToggle = $("priorityToggle");
const priorityCount = $("priorityCount");
const priorityList = $("priorityList");

const activityModal = $("activityModal");
const todoModal = $("todoModal");
const settingsModal = $("settingsModal");
const MODALS = [activityModal, todoModal, settingsModal];

const activityInput = $("activityInput");
const todoInput = $("todoInput");
const typeSelect = $("type");
const daysDiv = $("days");
const saveActivityBtn = $("saveActivity");
const saveTodoBtn = $("saveTodo");
const deleteActivityBtn = $("deleteActivity");
const deleteTodoBtn = $("deleteTodo");
const matrixDot = $("matrixDot");
const matrixLabel = $("matrixLabel");
const settingsBody = $("settingsBody");

const tabActivity = $("tabActivity");
const tabTodo = $("tabTodo");
const activityView = $("activityView");
const todoView = $("todoView");

/* ---------- DATE HELPERS ---------- */
function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Whole-day number from a YYYY-MM-DD key (UTC math avoids DST drift)
function dayNumber(key) {
  const [y, m, d] = key.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function makeToday(d = new Date()) {
  const key = dateKey(d);
  return { key, weekday: d.getDay(), num: dayNumber(key) };
}

let today = makeToday();

/* ---------- STORAGE HELPERS ---------- */
function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (e) {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("ZeroDay: could not save", key, e);
  }
}

function uid() {
  if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const isDateKey = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/* ---------- DATA MODEL ----------
   Activity: { id, text, type, days[], startDate, doneOn, reminder }
     doneOn === today's key -> completed today (resets automatically at midnight)
   To-Do:    { id, text, done, doneOn, importance, urgency }
     stays until completed; completed ones disappear the day after
   Settings: { enabled, todos: reminder }
---------------------------------- */
function normalizeReminder(r) {
  const src = r && typeof r === "object" ? r : {};
  return {
    on: src.on === true,
    from: isTime(src.from) ? src.from : DEFAULT_REMINDER.from,
    to: isTime(src.to) ? src.to : DEFAULT_REMINDER.to,
    level: LEVEL_KEYS.includes(src.level) ? src.level : DEFAULT_REMINDER.level
  };
}

const clampStar = (v) => {
  const n = Math.round(Number(v));
  return n >= 1 && n <= 3 ? n : 1;
};

function normalizeActivity(a) {
  if (!a || typeof a.text !== "string" || !a.text.trim()) return null;
  const days = Array.isArray(a.days)
    ? [...new Set(a.days.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))]
    : [];
  return {
    id: typeof a.id === "string" ? a.id : uid(),
    text: a.text.trim(),
    type: TYPES.includes(a.type) ? a.type : "daily",
    days,
    startDate: isDateKey(a.startDate) ? a.startDate : today.key,
    doneOn: isDateKey(a.doneOn) ? a.doneOn : null,
    reminder: normalizeReminder(a.reminder)
  };
}

function normalizeTodo(t) {
  if (!t || typeof t.text !== "string" || !t.text.trim()) return null;
  const done = t.done === true;
  return {
    id: typeof t.id === "string" ? t.id : uid(),
    text: t.text.trim(),
    done,
    doneOn: done ? (isDateKey(t.doneOn) ? t.doneOn : today.key) : null,
    importance: clampStar(t.importance),
    urgency: clampStar(t.urgency)
  };
}

function loadActivities() {
  const stored = readJSON(KEYS.activities, null);
  if (Array.isArray(stored)) return stored.map(normalizeActivity).filter(Boolean);

  // One-time migration from the old single "items" list
  const legacy = readJSON(KEYS.legacy, null);
  if (Array.isArray(legacy)) {
    const wasToday = localStorage.getItem(KEYS.lastDate) === new Date().toDateString();
    const migrated = legacy
      .map((i) =>
        normalizeActivity({
          text: i && i.text,
          type: i && i.type,
          days: i && i.days,
          doneOn: i && i.done && wasToday ? today.key : null
        })
      )
      .filter(Boolean);
    writeJSON(KEYS.activities, migrated);
    return migrated;
  }
  return [];
}

function loadTodos() {
  const stored = readJSON(KEYS.todos, []);
  return Array.isArray(stored) ? stored.map(normalizeTodo).filter(Boolean) : [];
}

function loadSettings() {
  const s = readJSON(KEYS.settings, {});
  return {
    enabled: !!s && s.enabled === true,
    todos: normalizeReminder(s && s.todos)
  };
}

let activities = loadActivities();
let todos = loadTodos();
let settings = loadSettings();

function pruneTodos() {
  const before = todos.length;
  todos = todos.filter((t) => !t.done || t.doneOn === today.key);
  return todos.length !== before;
}

function persist() {
  writeJSON(KEYS.activities, activities);
  writeJSON(KEYS.todos, todos);
  writeJSON(KEYS.settings, settings);
}

/* ---------- PRIORITY ---------- */
function priorityFrom(importance, urgency) {
  const score = clampStar(importance) + clampStar(urgency);
  if (score >= 5) return "high";
  if (score === 4) return "medium";
  return "low";
}

const priorityOf = (t) => priorityFrom(t.importance, t.urgency);

// Pending high + medium to-dos (red first)
function priorityTodos() {
  return todos
    .filter((t) => !t.done && priorityOf(t) !== "low")
    .sort((a, b) => PRIORITY[priorityOf(a)].rank - PRIORITY[priorityOf(b)].rank);
}

/* ---------- SCHEDULING ---------- */
function shouldShow(a) {
  if (a.type === "daily") return true;
  if (a.type === "alternate") {
    const diff = today.num - dayNumber(a.startDate);
    return ((diff % 2) + 2) % 2 === 0; // start day, then every 2nd day
  }
  if (a.type === "specific") return a.days.includes(today.weekday);
  return true;
}

function scheduleLabel(a) {
  if (a.type === "alternate") return "Alternate days";
  if (a.type === "specific") {
    return [...a.days].sort((x, y) => x - y).map((d) => DAY_NAMES[d]).join(" · ");
  }
  return "Daily";
}

const isActivityDone = (a) => a.doneOn === today.key;

/* ---------- HAPTICS ---------- */
function vibrate(pattern = 10) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

/* ---------- SMALL UI HELPERS ---------- */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function shake(node) {
  node.classList.remove("shake");
  void node.offsetWidth;
  node.classList.add("shake");
  vibrate(25);
}

let toastTimer = null;
function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

function pulse(ring) {
  ring.classList.remove("pulse");
  void ring.getBoundingClientRect();
  ring.classList.add("pulse");
}

[activityRing, todoRing].forEach((r) =>
  r.addEventListener("animationend", () => r.classList.remove("pulse"))
);

const CHEVRON_UP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
const CHEVRON_DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

/* ---------- DATE HEADER ---------- */
function renderDate() {
  $("date").textContent = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "short"
  });
}

/* ---------- RENDER SCHEDULING ---------- */
let renderTimer = null;
let dragging = false;

// Delayed render so completion animations can play; waits if a swipe is in progress
function scheduleRender(ms) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(function tick() {
    if (dragging) {
      renderTimer = setTimeout(tick, 120);
      return;
    }
    render();
  }, ms);
}

/* ---------- SWIPE + LONG PRESS ---------- */
let openSwipe = null;

// After a long press opens a modal, lifting the finger produces a click on
// whatever is now under it (e.g. Save). Swallow that trailing click.
let swallowClicks = false;

document.addEventListener(
  "click",
  (e) => {
    if (swallowClicks) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  },
  true
);

["touchend", "touchcancel"].forEach((type) =>
  document.addEventListener(
    type,
    () => {
      if (swallowClicks) setTimeout(() => (swallowClicks = false), 450);
    },
    true
  )
);

// A brand-new touch always starts clean
document.addEventListener(
  "touchstart",
  () => {
    swallowClicks = false;
  },
  { capture: true, passive: true }
);

// Tapping anywhere outside a revealed row closes it
document.addEventListener(
  "touchstart",
  (e) => {
    if (openSwipe && !openSwipe.wrapper.contains(e.target)) openSwipe.close();
  },
  { passive: true }
);

function rubber(v) {
  if (v > MAX_DRAG) return MAX_DRAG + (v - MAX_DRAG) * 0.25;
  if (v < -MAX_DRAG) return -MAX_DRAG + (v + MAX_DRAG) * 0.25;
  return v;
}

/*
  Swipe right  -> reveals Delete (tap it to confirm)
  Swipe left   -> completes (or un-completes) the row
  Long press   -> edit
*/
function attachSwipe(parts, actions) {
  const { wrapper, row, deleteBg, doneBg } = parts;

  let startX = 0;
  let startY = 0;
  let base = 0;
  let x = 0;
  let axis = null;
  let tracking = false;
  let settleTimer = null;
  let pressTimer = null;
  let longPressed = false;

  const swipe = {
    open: false,
    wrapper,
    close() {
      settle(0);
      swipe.open = false;
      if (openSwipe === swipe) openSwipe = null;
    }
  };

  function cancelPress() {
    clearTimeout(pressTimer);
    pressTimer = null;
  }

  function paint(v) {
    x = v;
    row.style.setProperty("--tx", v + "px");
    deleteBg.style.opacity = v > 4 ? Math.min(1, v / 48) : 0;
    doneBg.style.opacity = v < -4 ? Math.min(1, -v / 48) : 0;
  }

  // Spring to a resting position
  function settle(v) {
    row.classList.remove("dragging");
    clearTimeout(settleTimer);
    row.style.transition = "transform 0.38s cubic-bezier(0.34, 1.56, 0.64, 1)";
    paint(v);
    settleTimer = setTimeout(() => {
      row.style.transition = "";
    }, 400);
  }

  row.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      base = swipe.open ? OPEN_X : 0;
      axis = null;
      tracking = true;
      longPressed = false;
      clearTimeout(settleTimer);
      row.style.transition = "none";

      cancelPress();
      if (!swipe.open) {
        pressTimer = setTimeout(() => {
          pressTimer = null;
          if (tracking && axis === null) {
            longPressed = true;
            swallowClicks = true;
            tracking = false;
            row.style.transition = "";
            vibrate(20);
            actions.edit();
            setTimeout(() => {
              longPressed = false;
            }, 600);
          }
        }, LONG_PRESS_MS);
      }
    },
    { passive: true }
  );

  row.addEventListener(
    "touchmove",
    (e) => {
      if (!tracking) return;
      const t = e.touches[0];
      const mx = t.clientX - startX;
      const my = t.clientY - startY;

      if (axis === null) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        cancelPress();
        axis = Math.abs(mx) > Math.abs(my) * 1.2 ? "x" : "y";
        if (axis === "x") {
          dragging = true;
          row.classList.add("dragging");
        } else {
          // vertical scroll: leave it to the browser
          tracking = false;
          row.style.transition = "";
          return;
        }
      }

      paint(rubber(base + mx));
    },
    { passive: true }
  );

  function finish(e) {
    cancelPress();

    // After a long press, stop the browser from turning the release into a click
    if (longPressed && e && e.cancelable) e.preventDefault();

    if (!tracking) return;
    tracking = false;

    if (axis !== "x") {
      row.style.transition = "";
      return;
    }

    dragging = false;

    if (x <= -COMPLETE_TRIGGER) {
      swipe.open = false;
      if (openSwipe === swipe) openSwipe = null;
      settle(0);
      actions.toggle();
    } else if (x >= OPEN_TRIGGER) {
      settle(OPEN_X);
      if (!swipe.open) vibrate(20);
      swipe.open = true;
      openSwipe = swipe;
    } else {
      swipe.close();
    }
  }

  row.addEventListener("touchend", finish);
  row.addEventListener("touchcancel", finish);

  // Block the browser's long-press menu; right-click also opens edit (desktop)
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!longPressed && !swipe.open) actions.edit();
  });

  // A tap on a revealed row just closes it; a long press never triggers a tap
  row.addEventListener(
    "click",
    (e) => {
      if (longPressed) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (swipe.open) {
        e.preventDefault();
        e.stopPropagation();
        swipe.close();
      }
    },
    true
  );

  deleteBg.addEventListener("click", () => {
    if (openSwipe === swipe) openSwipe = null;
    actions.remove();
  });
}

/* ---------- REORDER ---------- */
let reorderMode = false;

function moveActivity(id, dir) {
  // Swap with the neighbouring *visible* activity so hidden ones stay put
  const visible = activities.filter(shouldShow);
  const i = visible.findIndex((a) => a.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= visible.length) return;

  const ai = activities.indexOf(visible[i]);
  const aj = activities.indexOf(visible[j]);
  [activities[ai], activities[aj]] = [activities[aj], activities[ai]];

  persist();
  vibrate(8);
  render({ flip: true });
}

reorderBtn.addEventListener("click", () => {
  if (openSwipe) openSwipe.close();
  reorderMode = !reorderMode;
  vibrate(8);
  render();
});

/* ---------- ROW BUILDER ---------- */
function buildRow(entry, kind, ctx = {}) {
  const isActivity = kind === "activity";
  const isDone = () => (isActivity ? isActivityDone(entry) : entry.done === true);

  const wrapper = el("div", "item-wrapper " + kind);
  wrapper.dataset.id = entry.id;

  const row = el("div", "item" + (isDone() ? " completed" : ""));

  const box = el("input", "check");
  box.type = "checkbox";
  box.checked = isDone();
  box.setAttribute("aria-label", "Complete " + entry.text);

  const body = el("div", "item-body");
  body.appendChild(el("span", "label", entry.text));
  if (isActivity) body.appendChild(el("span", "meta", scheduleLabel(entry)));

  row.append(box, body);

  if (!isActivity) {
    const p = priorityOf(entry);
    const dot = el("i", "pdot " + p);
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", PRIORITY[p].label);
    row.appendChild(dot);
  }

  /* Reorder mode: up / down controls, no swipe or edit */
  if (isActivity && ctx.reorder) {
    row.classList.add("reordering");

    const controls = el("div", "reorder");
    const up = el("button");
    const down = el("button");
    up.type = down.type = "button";
    up.innerHTML = CHEVRON_UP;
    down.innerHTML = CHEVRON_DOWN;
    up.setAttribute("aria-label", "Move " + entry.text + " up");
    down.setAttribute("aria-label", "Move " + entry.text + " down");
    up.disabled = ctx.index === 0;
    down.disabled = ctx.index === ctx.count - 1;
    up.addEventListener("click", () => moveActivity(entry.id, -1));
    down.addEventListener("click", () => moveActivity(entry.id, 1));
    controls.append(up, down);

    row.appendChild(controls);
    wrapper.appendChild(row);
    return wrapper;
  }

  const doneBg = el("div", "done-bg", isDone() ? "Undo" : "Done");
  const deleteBg = el("button", "delete-bg", "Delete");
  deleteBg.type = "button";
  wrapper.append(doneBg, deleteBg, row);

  function setDone(value) {
    entry.doneOn = value ? today.key : null;
    if (!isActivity) entry.done = value;

    box.checked = value;
    row.classList.toggle("completed", value);
    doneBg.textContent = value ? "Undo" : "Done";

    persist();
    updateRings();

    if (value) {
      vibrate(15);
      row.classList.remove("success");
      void row.offsetWidth;
      row.classList.add("success");
      pulse(isActivity ? activityRing : todoRing);
    } else {
      vibrate(8);
    }

    scheduleRender(value ? 320 : 150);
  }

  function remove() {
    vibrate(30);
    removeEntry(entry, kind);
    updateRings();

    // Slide out, then collapse
    row.style.transition = "transform 0.22s ease, opacity 0.22s ease";
    row.style.setProperty("--tx", "110%");
    row.style.opacity = "0";

    const h = wrapper.offsetHeight;
    wrapper.style.height = h + "px";
    wrapper.style.transition = "height 0.22s ease 0.1s, margin 0.22s ease 0.1s, opacity 0.22s ease 0.1s";
    void wrapper.offsetHeight;
    wrapper.style.height = "0px";
    wrapper.style.marginTop = "0px";
    wrapper.style.opacity = "0";

    scheduleRender(380);
  }

  box.addEventListener("change", () => setDone(box.checked));

  attachSwipe(
    { wrapper, row, deleteBg, doneBg },
    {
      toggle: () => setDone(!isDone()),
      remove,
      edit: () => (isActivity ? openActivityModal(entry) : openTodoModal(entry))
    }
  );

  return wrapper;
}

// Remove by id (never by list position), so hidden items are never affected
function removeEntry(entry, kind) {
  if (kind === "activity") {
    activities = activities.filter((a) => a.id !== entry.id);
  } else {
    todos = todos.filter((t) => t.id !== entry.id);
  }
  persist();
}

/* ---------- PRIORITY PANEL ---------- */
function renderPriorityPanel() {
  const items = priorityTodos();
  priorityPanel.classList.toggle("hidden", !items.length);

  priorityList.innerHTML = "";
  priorityCount.innerHTML = "";

  const highCount = items.filter((t) => priorityOf(t) === "high").length;
  const medCount = items.length - highCount;

  [["high", highCount], ["medium", medCount]].forEach(([p, n]) => {
    if (!n) return;
    const chip = el("span", "chip");
    chip.append(el("i", "pdot " + p), document.createTextNode(String(n)));
    priorityCount.appendChild(chip);
  });

  items.forEach((t) => {
    const row = el("div", "prio-row");
    const box = el("input", "check check-sm");
    box.type = "checkbox";
    box.setAttribute("aria-label", "Complete " + t.text);
    const label = el("span", "label", t.text);
    const p = priorityOf(t);
    const dot = el("i", "pdot " + p);
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", PRIORITY[p].label);

    box.addEventListener("change", () => {
      if (!box.checked) return;
      t.done = true;
      t.doneOn = today.key;
      row.classList.add("completed");
      persist();
      updateRings();
      vibrate(15);
      pulse(todoRing);
      scheduleRender(320);
    });

    row.append(box, label, dot);
    priorityList.appendChild(row);
  });
}

priorityToggle.addEventListener("click", () => {
  const open = priorityPanel.classList.toggle("open");
  priorityToggle.setAttribute("aria-expanded", String(open));
  vibrate(6);
});

/* ---------- RENDER ---------- */
function renderEmpty(container, message) {
  container.appendChild(el("p", "empty", message));
}

// FLIP: animate rows from their old position to the new one
function playFlip(before) {
  const moved = [];
  activityList.querySelectorAll(".item-wrapper[data-id]").forEach((w) => {
    const old = before.get(w.dataset.id);
    if (old === undefined) return;
    const d = old - w.getBoundingClientRect().top;
    if (Math.abs(d) > 1) {
      w.style.transition = "none";
      w.style.transform = `translateY(${d}px)`;
      moved.push(w);
    }
  });
  if (!moved.length) return;

  void document.body.offsetHeight;
  moved.forEach((w) => {
    w.style.transition = "transform 0.3s cubic-bezier(0.34, 1.3, 0.64, 1)";
    w.style.transform = "";
    setTimeout(() => {
      w.style.transition = "";
    }, 340);
  });
}

function render(opts = {}) {
  openSwipe = null;

  let before = null;
  if (opts.flip) {
    before = new Map();
    activityList.querySelectorAll(".item-wrapper[data-id]").forEach((w) =>
      before.set(w.dataset.id, w.getBoundingClientRect().top)
    );
  }

  activityList.innerHTML = "";
  todoList.innerHTML = "";

  const todayActivities = activities.filter(shouldShow);
  if (todayActivities.length < 2) reorderMode = false;

  activityHead.classList.toggle("hidden", todayActivities.length < 2);
  reorderBtn.textContent = reorderMode ? "Done" : "Reorder";

  if (!todayActivities.length) {
    renderEmpty(
      activityList,
      activities.length ? "Nothing scheduled today." : "No activities yet.\nTap + to add one."
    );
  } else {
    todayActivities.forEach((a, index) =>
      activityList.appendChild(
        buildRow(a, "activity", { reorder: reorderMode, index, count: todayActivities.length })
      )
    );
  }

  if (!todos.length) {
    renderEmpty(todoList, "All clear.\nTap + to add a To-Do.");
  } else {
    todos.forEach((t) => todoList.appendChild(buildRow(t, "todo")));
  }

  renderPriorityPanel();
  updateRings();

  if (before) playFlip(before);
}

/* ---------- PROGRESS ---------- */
let ringsReady = false; // lets the rings animate in on first load

function setRing(ring, circumference, ratio) {
  ring.style.strokeDashoffset = circumference * (1 - ratio);
  ring.style.opacity = ratio > 0 ? "1" : "0";
}

function updateRings() {
  const todayActivities = activities.filter(shouldShow);
  const actDone = todayActivities.filter(isActivityDone).length;
  const todoDone = todos.filter((t) => t.done).length;

  const actRatio = todayActivities.length ? actDone / todayActivities.length : 0;
  const todoRatio = todos.length ? todoDone / todos.length : 0;

  progressText.textContent = Math.round(actRatio * 100) + "%";
  legendActivity.textContent = `Activities ${actDone}/${todayActivities.length}`;
  legendTodo.textContent = `To-Dos ${todoDone}/${todos.length}`;
  todoCount.textContent = todos.length ? `${todoDone} of ${todos.length} done` : "";

  progressWrapper.setAttribute(
    "aria-label",
    `${actDone} of ${todayActivities.length} activities and ${todoDone} of ${todos.length} to-dos complete`
  );

  if (ringsReady) {
    setRing(activityRing, OUTER_C, actRatio);
    setRing(todoRing, INNER_C, todoRatio);
  }
}

/* ---------- TABS ---------- */
let activeTab = "activity";

function setTab(name) {
  if (name === activeTab) return;
  activeTab = name;
  if (openSwipe) openSwipe.close();

  const isActivity = name === "activity";
  activityView.classList.toggle("active", isActivity);
  todoView.classList.toggle("active", !isActivity);
  tabActivity.classList.toggle("active", isActivity);
  tabTodo.classList.toggle("active", !isActivity);
  tabActivity.setAttribute("aria-selected", String(isActivity));
  tabTodo.setAttribute("aria-selected", String(!isActivity));

  vibrate(8);
  window.scrollTo(0, 0);
}

tabActivity.addEventListener("click", () => setTab("activity"));
tabTodo.addEventListener("click", () => setTab("todo"));

/* ---------- MODALS ---------- */
let editingActivity = null;
let editingTodo = null;
let resetTimer = null;
const matrix = { importance: 1, urgency: 1 };

function paintMatrix() {
  document.querySelectorAll("#matrix .stars").forEach((group) => {
    const key = group.dataset.key;
    group.querySelectorAll("button").forEach((b) => {
      const on = Number(b.dataset.v) <= matrix[key];
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  });
  const p = priorityFrom(matrix.importance, matrix.urgency);
  matrixDot.className = "pdot " + p;
  matrixLabel.textContent = PRIORITY[p].label;
}

$("matrix").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-v]");
  if (!btn) return;
  matrix[btn.parentElement.dataset.key] = Number(btn.dataset.v);
  vibrate(6);
  paintMatrix();
});

function resetDeleteArm() {
  [deleteActivityBtn, deleteTodoBtn].forEach((b) => {
    clearTimeout(b._t);
    b.dataset.armed = "";
    b.textContent = "Delete";
  });
}

function resetForms() {
  editingActivity = null;
  editingTodo = null;

  activityInput.value = "";
  todoInput.value = "";
  typeSelect.value = "daily";
  daysDiv.classList.add("hidden");
  daysDiv.querySelectorAll("input").forEach((cb) => (cb.checked = false));

  matrix.importance = 1;
  matrix.urgency = 1;
  paintMatrix();

  $("activityModalTitle").textContent = "Add Activity";
  $("todoModalTitle").textContent = "Add To-Do";
  saveActivityBtn.textContent = "Add";
  saveTodoBtn.textContent = "Add";
  deleteActivityBtn.classList.add("hidden");
  deleteTodoBtn.classList.add("hidden");
  resetDeleteArm();
}

function openModal(modal, focusEl) {
  if (openSwipe) openSwipe.close();
  clearTimeout(resetTimer);
  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");
  vibrate(10);
  setTimeout(() => {
    if (modal.classList.contains("active") && focusEl) focusEl.focus({ preventScroll: true });
  }, 180);
}

function closeModal(modal) {
  modal.classList.remove("active");
  modal.setAttribute("aria-hidden", "true");
  if (document.activeElement && modal.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  clearTimeout(resetTimer);
  resetTimer = setTimeout(() => {
    if (!MODALS.some((m) => m.classList.contains("active"))) resetForms();
  }, 300);
}

/* Activity modal (add or edit) */
function openActivityModal(activity) {
  if (activityModal.classList.contains("active")) return;
  clearTimeout(resetTimer);
  resetForms();

  if (activity) {
    editingActivity = activity;
    $("activityModalTitle").textContent = "Edit Activity";
    saveActivityBtn.textContent = "Save";
    deleteActivityBtn.classList.remove("hidden");
    activityInput.value = activity.text;
    typeSelect.value = activity.type;
    daysDiv.classList.toggle("hidden", activity.type !== "specific");
    daysDiv.querySelectorAll("input").forEach((cb) => {
      cb.checked = activity.days.includes(parseInt(cb.value, 10));
    });
  }

  openModal(activityModal, activity ? null : activityInput);
}

/* To-Do modal (add or edit) */
function openTodoModal(todo) {
  if (todoModal.classList.contains("active")) return;
  clearTimeout(resetTimer);
  resetForms();

  if (todo) {
    editingTodo = todo;
    $("todoModalTitle").textContent = "Edit To-Do";
    saveTodoBtn.textContent = "Save";
    deleteTodoBtn.classList.remove("hidden");
    todoInput.value = todo.text;
    matrix.importance = todo.importance;
    matrix.urgency = todo.urgency;
    paintMatrix();
  }

  openModal(todoModal, todo ? null : todoInput);
}

$("addActivityBtn").addEventListener("click", () => openActivityModal(null));
$("addTodoBtn").addEventListener("click", () => openTodoModal(null));

document.querySelectorAll("[data-close]").forEach((btn) =>
  btn.addEventListener("click", () => closeModal(btn.closest(".modal")))
);

// Only dismiss when the press *started* on the backdrop, so the tail end of a
// long press (which opened the modal) can't immediately close it again.
MODALS.forEach((modal) => {
  let downOnBackdrop = false;
  modal.addEventListener("pointerdown", (e) => {
    downOnBackdrop = e.target === modal;
  });
  modal.addEventListener("click", (e) => {
    const shouldClose = e.target === modal && downOnBackdrop;
    downOnBackdrop = false;
    if (shouldClose) closeModal(modal);
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    MODALS.forEach((m) => {
      if (m.classList.contains("active")) closeModal(m);
    });
  }
});

/* Schedule type -> show/hide weekday picker */
typeSelect.addEventListener("change", () => {
  daysDiv.classList.toggle("hidden", typeSelect.value !== "specific");
});

/* Two-tap delete inside edit modals */
function armDelete(btn, onConfirm) {
  if (btn.dataset.armed === "1") {
    clearTimeout(btn._t);
    btn.dataset.armed = "";
    btn.textContent = "Delete";
    onConfirm();
    return;
  }
  btn.dataset.armed = "1";
  btn.textContent = "Tap again to delete";
  vibrate(15);
  btn._t = setTimeout(() => {
    btn.dataset.armed = "";
    btn.textContent = "Delete";
  }, 3000);
}

deleteActivityBtn.addEventListener("click", () =>
  armDelete(deleteActivityBtn, () => {
    const target = editingActivity;
    if (!target) return;
    vibrate(30);
    removeEntry(target, "activity");
    closeModal(activityModal);
    render();
    toast("Activity deleted");
  })
);

deleteTodoBtn.addEventListener("click", () =>
  armDelete(deleteTodoBtn, () => {
    const target = editingTodo;
    if (!target) return;
    vibrate(30);
    removeEntry(target, "todo");
    closeModal(todoModal);
    render();
    toast("To-Do deleted");
  })
);

/* ---------- SAVE ACTIVITY (add / edit) ---------- */
function saveActivity() {
  const text = activityInput.value.trim();
  if (!text) {
    shake(activityInput);
    activityInput.focus();
    return;
  }

  const type = typeSelect.value;
  let days = [];

  if (type === "specific") {
    days = [...daysDiv.querySelectorAll("input:checked")].map((cb) => parseInt(cb.value, 10));
    if (!days.length) {
      shake(daysDiv);
      return;
    }
  }

  if (editingActivity) {
    const a = editingActivity;
    if (type === "alternate" && a.type !== "alternate") a.startDate = today.key;
    a.text = text;
    a.type = type;
    a.days = days;
    persist();
    closeModal(activityModal);
    render();
    toast(shouldShow(a) ? "Saved" : "Saved. Not scheduled for today.");
    return;
  }

  const activity = {
    id: uid(),
    text,
    type,
    days,
    startDate: today.key,
    doneOn: null,
    reminder: normalizeReminder(null)
  };
  activities.push(activity);
  persist();
  closeModal(activityModal);
  render();

  if (!shouldShow(activity)) toast("Added. Not scheduled for today.");
  else if (activeTab !== "activity") toast("Activity added");
}

saveActivityBtn.addEventListener("click", saveActivity);
activityInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveActivity();
  }
});

/* ---------- SAVE TODO (add / edit) ---------- */
function saveTodo() {
  const text = todoInput.value.trim();
  if (!text) {
    shake(todoInput);
    todoInput.focus();
    return;
  }

  if (editingTodo) {
    editingTodo.text = text;
    editingTodo.importance = matrix.importance;
    editingTodo.urgency = matrix.urgency;
    persist();
    closeModal(todoModal);
    render();
    toast("Saved");
    return;
  }

  todos.push({
    id: uid(),
    text,
    done: false,
    doneOn: null,
    importance: matrix.importance,
    urgency: matrix.urgency
  });
  persist();
  closeModal(todoModal);
  render();

  if (activeTab !== "todo") toast("To-Do added");
}

saveTodoBtn.addEventListener("click", saveTodo);
todoInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveTodo();
  }
});

/* =====================================================
   NOTIFICATIONS
   Real system notifications (via the service worker),
   sent on a schedule while ZeroDay is running.
   ===================================================== */
const notifSupported = () => "Notification" in window && "serviceWorker" in navigator;
const canNotify = () => notifSupported() && Notification.permission === "granted";

async function showNotice(title, body, tag, level) {
  if (!canNotify()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const L = LEVELS[level] || LEVELS.medium;
    await reg.showNotification(title, {
      body,
      tag,
      renotify: true,
      icon: "icon.png",
      badge: "icon.png",
      vibrate: L.vibrate,
      requireInteraction: L.sticky,
      data: { url: "./" }
    });
    return true;
  } catch (e) {
    console.warn("ZeroDay: notification failed", e);
    return false;
  }
}

function toMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/* Which reminder "slot" are we in? Slots start at the window's From time and
   repeat every `every` minutes. Handles overnight windows (e.g. 22:00 to 06:00). */
function windowSlot(now, from, to, every) {
  const f = toMinutes(from);
  const t = toMinutes(to);
  const n = now.getHours() * 60 + now.getMinutes();
  if (f === t) return null;

  let elapsed;
  const startDay = new Date(now);

  if (f < t) {
    if (n < f || n >= t) return null;
    elapsed = n - f;
  } else if (n >= f) {
    elapsed = n - f;
  } else if (n < t) {
    elapsed = 1440 - f + n;
    startDay.setDate(startDay.getDate() - 1);
  } else {
    return null;
  }
  return { day: dateKey(startDay), slot: Math.floor(elapsed / every) };
}

function notifyTodos(pending, level) {
  const high = pending.some((t) => priorityOf(t) === "high");
  const title = (high ? "High priority" : "Priority") + (pending.length > 1 ? " To-Dos" : " To-Do");
  const names = pending.slice(0, 3).map((t) => t.text).join(", ");
  const body = pending.length === 1 ? pending[0].text : `${pending.length} waiting: ${names}${pending.length > 3 ? "…" : ""}`;
  return showNotice(title, body, "todos", level);
}

function notifyActivity(a) {
  return showNotice(a.text, "Still to do today.", "act-" + a.id, a.reminder.level);
}

/* Called on a timer. Fires at most one notification per target per slot, and
   holds them while the app is on screen (you're already looking at it). */
function checkReminders(now = new Date(), opts = {}) {
  const fired = [];
  if (!settings.enabled || !canNotify()) return fired;
  if (document.visibilityState === "visible" && !opts.ignoreVisibility) return fired;

  const state = readJSON(KEYS.notifState, {});
  let changed = false;

  function due(key, cfg) {
    const w = windowSlot(now, cfg.from, cfg.to, LEVELS[cfg.level].every);
    if (!w) return false;
    const s = state[key];
    if (s && s.day === w.day && s.slot >= w.slot) return false;
    state[key] = { day: w.day, slot: w.slot };
    changed = true;
    return true;
  }

  if (settings.todos.on) {
    const pending = priorityTodos();
    if (pending.length && due("todos", settings.todos)) {
      notifyTodos(pending, settings.todos.level);
      fired.push("todos");
    }
  }

  activities.forEach((a) => {
    const r = a.reminder;
    if (r.on && shouldShow(a) && !isActivityDone(a) && due("act:" + a.id, r)) {
      notifyActivity(a);
      fired.push(a.id);
    }
  });

  if (changed) writeJSON(KEYS.notifState, state);
  return fired;
}

/* ---------- SETTINGS SHEET ---------- */
function makeSwitch(checked, label, onChange) {
  const wrap = el("label", "switch");
  const input = el("input");
  input.type = "checkbox";
  input.checked = checked;
  input.setAttribute("aria-label", label);
  wrap.append(input, el("span", "knob"));
  input.addEventListener("change", () => {
    vibrate(8);
    onChange(input.checked, input);
  });
  return wrap;
}

function timeField(label, value, onChange) {
  const wrap = el("label", "time-field");
  wrap.appendChild(el("span", null, label));
  const input = el("input", "field");
  input.type = "time";
  input.value = value;
  let current = value;
  input.addEventListener("change", () => {
    if (isTime(input.value)) {
      current = input.value;
      onChange(current);
    } else {
      input.value = current;
    }
  });
  wrap.appendChild(input);
  return wrap;
}

function buildReminderCard({ title, subtitle, cfg, isTodo }) {
  const card = el("div", "rem-card" + (isTodo ? " todo-card" : "") + (cfg.on ? " on" : ""));

  const head = el("div", "rem-head");
  const names = el("div", "rem-names");
  names.appendChild(el("span", "rem-title", title));
  if (subtitle) names.appendChild(el("span", "rem-sub", subtitle));
  head.append(
    names,
    makeSwitch(cfg.on, "Remind me: " + title, (on) => {
      cfg.on = on;
      card.classList.toggle("on", on);
      persist();
    })
  );

  const blurb = el("div", "rem-blurb");
  const refresh = () => {
    const L = LEVELS[cfg.level];
    if (cfg.from === cfg.to) {
      blurb.textContent = "Choose two different times.";
      blurb.classList.add("warn");
    } else {
      blurb.textContent = `${L.freq}, ${cfg.from} to ${cfg.to}. ${L.feel[0].toUpperCase()}${L.feel.slice(1)}.`;
      blurb.classList.remove("warn");
    }
  };

  const times = el("div", "time-row");
  times.append(
    timeField("From", cfg.from, (v) => {
      cfg.from = v;
      persist();
      refresh();
    }),
    timeField("To", cfg.to, (v) => {
      cfg.to = v;
      persist();
      refresh();
    })
  );

  const seg = el("div", "seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Intensity");
  LEVEL_KEYS.forEach((key) => {
    const b = el("button", null, LEVELS[key].label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(cfg.level === key));
    b.addEventListener("click", () => {
      cfg.level = key;
      seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      persist();
      refresh();
      vibrate(LEVELS[key].vibrate); // feel the intensity
    });
    seg.appendChild(b);
  });

  refresh();

  const fields = el("div", "rem-fields");
  fields.append(times, seg, blurb);
  const inner = el("div", "rem-inner");
  inner.appendChild(fields);
  const bodyWrap = el("div", "rem-body");
  bodyWrap.appendChild(inner);

  card.append(head, bodyWrap);
  return card;
}

function statusText() {
  if (!notifSupported()) {
    return "Not supported here. On iPhone, add ZeroDay to your Home Screen first.";
  }
  if (Notification.permission === "denied") {
    return "Blocked. Allow notifications for this site in your browser settings.";
  }
  return settings.enabled && Notification.permission === "granted"
    ? "On"
    : "Off. Reminders are paused.";
}

function renderSettings() {
  settingsBody.innerHTML = "";

  /* Master switch */
  const master = el("div", "rem-card on");
  const mHead = el("div", "rem-head");
  const mNames = el("div", "rem-names");
  mNames.appendChild(el("span", "rem-title", "Allow notifications"));
  const status = el("span", "rem-sub", statusText());
  mNames.appendChild(status);

  const mSwitch = makeSwitch(
    settings.enabled && canNotify(),
    "Allow notifications",
    async (on, input) => {
      if (on) {
        if (!notifSupported()) {
          input.checked = false;
        } else {
          let perm = Notification.permission;
          if (perm === "default") {
            try {
              perm = await Notification.requestPermission();
            } catch (e) {
              perm = "denied";
            }
          }
          if (perm === "granted") {
            settings.enabled = true;
          } else {
            settings.enabled = false;
            input.checked = false;
          }
        }
      } else {
        settings.enabled = false;
      }
      persist();
      status.textContent = statusText();
    }
  );
  mHead.append(mNames, mSwitch);
  master.appendChild(mHead);
  settingsBody.appendChild(master);

  const testBtn = el("button", "ghost-btn", "Send a test notification");
  testBtn.type = "button";
  testBtn.addEventListener("click", async () => {
    if (!canNotify()) {
      toast("Turn on notifications first");
      return;
    }
    const ok = await showNotice("ZeroDay", "This is what a reminder looks like.", "test", "medium");
    toast(ok ? "Test sent" : "Couldn't send the test");
  });
  settingsBody.appendChild(testBtn);

  /* Priority to-dos */
  settingsBody.appendChild(el("div", "settings-group", "To-Dos"));
  settingsBody.appendChild(
    buildReminderCard({
      title: "Priority To-Dos",
      subtitle: "Red and yellow to-dos that are still open",
      cfg: settings.todos,
      isTodo: true
    })
  );

  /* Each activity */
  settingsBody.appendChild(el("div", "settings-group", "Activities"));
  if (!activities.length) {
    settingsBody.appendChild(el("p", "settings-note", "Add an activity to set a reminder for it."));
  } else {
    activities.forEach((a) =>
      settingsBody.appendChild(
        buildReminderCard({ title: a.text, subtitle: scheduleLabel(a), cfg: a.reminder, isTodo: false })
      )
    );
  }

  settingsBody.appendChild(
    el(
      "p",
      "settings-note",
      "Activity reminders only appear on days the activity is scheduled, until it's checked off. " +
        "Reminders are sent while ZeroDay is running in the background, and are held while you have it open. " +
        "A fully closed app can't send them without a push server."
    )
  );
}

$("settingsBtn").addEventListener("click", () => {
  renderSettings();
  openModal(settingsModal, null);
});

/* ---------- NEW DAY + REMINDER TICK ----------
   Activity completion resets on its own (doneOn no longer equals today).
   syncDay refreshes the UI if the app stays open past midnight. */
function syncDay() {
  if (dateKey() === today.key) return;
  today = makeToday();
  localStorage.setItem(KEYS.lastDate, today.key);
  pruneTodos();
  persist();
  renderDate();
  scheduleRender(0);
}

function tick() {
  syncDay();
  checkReminders();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) syncDay();
  else checkReminders(); // just left the app: send anything that was held
});
window.addEventListener("pageshow", syncDay);
window.addEventListener("focus", syncDay);
setInterval(tick, 30000);

/* ---------- INIT ---------- */
renderDate();
pruneTodos();
resetForms();
persist();
localStorage.setItem(KEYS.lastDate, today.key);
render();

// Let the rings animate in from empty
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    ringsReady = true;
    updateRings();
  })
);

/* ---------- PWA ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch((err) => {
      console.warn("ZeroDay: service worker registration failed", err);
    });
  });
}
