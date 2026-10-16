// Service worker for HQ push reminders. Must live at the site root (public/) so it
// can receive notifications while the app is closed.
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-auth-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js");

const firebaseConfig = {
  apiKey: "AIzaSyBZ15HhvM6LnYhkSF1T-XXZi1WMkC4OB4A",
  authDomain: "my-hq-6082b.firebaseapp.com",
  projectId: "my-hq-6082b",
  storageBucket: "my-hq-6082b.firebasestorage.app",
  messagingSenderId: "294542508151",
  appId: "1:294542508151:web:aa564518efe649d4730672",
};
firebase.initializeApp(firebaseConfig);

const messaging = firebase.messaging();

// Take over as soon as a new version is downloaded, instead of waiting until every HQ
// window is closed (an installed app on Android can stay open in the background for
// days, so the old notification code would otherwise keep running).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(clients.claim()));

// Keep in step with REMINDER_LEAD_MINUTES in index.html.
const REMINDER_LEAD_MINUTES = 0;

// The Cloud Function sends data-only messages, so we build the notification here.
// The page builds the same notification when it is open (see onMessage in index.html).
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  return self.registration.showNotification(d.title || "HQ", {
    body: d.body || "",
    tag: d.tag || undefined,
    data: { url: d.url || "./", taskId: d.tag || "" },
    actions: d.tag ? [{ action: "complete", title: "✓ Complete" }] : [],
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  if (event.action === "complete" && data.taskId) {
    // If completing fails (signed out, offline), open the app so it can be done there.
    event.waitUntil(
      completeTask(data.taskId).catch((err) => {
        console.error("Couldn't complete task from notification", err);
        return openApp(data.url);
      }),
    );
    return;
  }
  // Tapping the notification itself opens (or focuses) the app.
  event.waitUntil(openApp(data.url));
});

function openApp(url) {
  return clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) return client.focus();
      }
      return clients.openWindow(url || "./");
    });
}

// ---- completing a task without opening the app ----
// The page's sign-in is stored in IndexedDB, which this worker can read too. Firestore's
// own SDK doesn't run in a service worker, so the task is updated through the REST API,
// with the user's ID token, which goes through the same security rules as the app.

function currentUser() {
  const auth = firebase.auth();
  return new Promise((resolve) => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

const pad = (n) => String(n).padStart(2, "0");
function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDays(dateKeyStr, n) {
  const [y, m, d] = dateKeyStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return dateKey(dt);
}
function addMonths(dateKeyStr, n) {
  const [y, m, d] = dateKeyStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setMonth(dt.getMonth() + n);
  return dateKey(dt);
}
// Same as reminderFor in index.html, but returns a Firestore REST value.
function reminderValue(dateKeyStr, timeStr) {
  if (!dateKeyStr || !timeStr) return { nullValue: null };
  const [y, m, d] = dateKeyStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const when = new Date(y, m - 1, d, hh, mm, 0, 0);
  when.setMinutes(when.getMinutes() - REMINDER_LEAD_MINUTES);
  return when.getTime() > Date.now()
    ? { timestampValue: when.toISOString() }
    : { nullValue: null };
}

async function completeTask(taskId) {
  const user = await currentUser();
  if (!user) throw new Error("Not signed in");
  const idToken = await user.getIdToken();
  const docUrl =
    `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}` +
    `/databases/(default)/documents/users/${user.uid}/todos/${encodeURIComponent(taskId)}`;
  const headers = { Authorization: `Bearer ${idToken}` };

  const getRes = await fetch(docUrl, { headers });
  if (getRes.status === 404) return; // deleted in the meantime: nothing to do
  if (!getRes.ok) throw new Error(`Reading task failed (${getRes.status})`);
  const docJson = await getRes.json();
  const f = docJson.fields || {};
  const str = (k) => (f[k] && f[k].stringValue) || "";
  if (f.completed && f.completed.booleanValue) return;

  // Same rule as toggleTodoComplete in index.html: a recurring task rolls its due
  // date forward instead of being marked done.
  const recurrence = str("recurrence");
  const dueDate = str("dueDate");
  let fields;
  if (recurrence && recurrence !== "none" && dueDate) {
    let nextDate = dueDate;
    if (recurrence === "daily") nextDate = addDays(dueDate, 1);
    else if (recurrence === "weekly") nextDate = addDays(dueDate, 7);
    else if (recurrence === "monthly") nextDate = addMonths(dueDate, 1);
    fields = {
      dueDate: { stringValue: nextDate },
      reminderAt: reminderValue(nextDate, str("dueTime")),
    };
  } else {
    fields = { completed: { booleanValue: true }, reminderAt: { nullValue: null } };
  }

  // Only write if the task hasn't changed since it was read, and never recreate a
  // task that was deleted in between.
  const params = new URLSearchParams();
  Object.keys(fields).forEach((k) => params.append("updateMask.fieldPaths", k));
  params.append("currentDocument.updateTime", docJson.updateTime);
  const patchRes = await fetch(`${docUrl}?${params}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!patchRes.ok) throw new Error(`Updating task failed (${patchRes.status})`);
}
