// Service worker for HQ push reminders. Must live at the site root (public/) so it
// can receive notifications while the app is closed.
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBZ15HhvM6LnYhkSF1T-XXZi1WMkC4OB4A",
  authDomain: "my-hq-6082b.firebaseapp.com",
  projectId: "my-hq-6082b",
  storageBucket: "my-hq-6082b.firebasestorage.app",
  messagingSenderId: "294542508151",
  appId: "1:294542508151:web:aa564518efe649d4730672",
});

const messaging = firebase.messaging();

// The Cloud Function sends data-only messages, so we build the notification here.
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  return self.registration.showNotification(d.title || "HQ", {
    body: d.body || "",
    tag: d.tag || undefined,
    data: { url: d.url || "./" },
  });
});

// Tapping a notification opens (or focuses) the app.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if ("focus" in client) return client.focus();
        }
        return clients.openWindow(url);
      }),
  );
});
