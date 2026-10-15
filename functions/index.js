// Sends a push reminder when a task's reminderAt time has arrived.
// Runs every minute. Each task has a reminderAt Timestamp; once the push is sent the
// field is set to null, so the query below only ever sees reminders still waiting.
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

// Same UID as ALLOWED_UID in index.html: this is a single-user app.
const OWNER_UID = "uoU0LB6GMTZ4af7NWJIpE8oKsDU2";

const DEAD_TOKEN_ERRORS = [
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
];

exports.sendTaskReminders = onSchedule(
  { schedule: "every 1 minutes", maxInstances: 1 },
  async () => {
    const userRef = db.collection("users").doc(OWNER_UID);

    const dueSnap = await userRef
      .collection("todos")
      .where("reminderAt", "<=", Timestamp.now())
      .limit(50)
      .get();
    if (dueSnap.empty) return;

    const deviceSnap = await userRef.collection("devices").get();
    const devices = deviceSnap.docs
      .map((d) => ({ ref: d.ref, token: d.data().token }))
      .filter((d) => d.token);

    for (const snap of dueSnap.docs) {
      const todo = snap.data();

      // Completed in the meantime, or nowhere to send it: just clear the reminder.
      if (todo.completed || devices.length === 0) {
        await snap.ref.update({ reminderAt: null });
        continue;
      }

      try {
        const res = await getMessaging().sendEachForMulticast({
          tokens: devices.map((d) => d.token),
          data: {
            title: String(todo.title || "Task due"),
            body: todo.dueTime ? `Due at ${todo.dueTime}` : "Due now",
            tag: snap.id,
            url: "./",
          },
          webpush: { headers: { Urgency: "high", TTL: "3600" } },
        });

        // Remove devices whose tokens are no longer valid (app uninstalled, permission revoked).
        const deletions = [];
        res.responses.forEach((r, i) => {
          if (!r.success && r.error && DEAD_TOKEN_ERRORS.includes(r.error.code)) {
            deletions.push(devices[i].ref.delete());
          }
        });
        await Promise.all(deletions);

        logger.info("Reminder sent", {
          task: snap.id,
          delivered: res.successCount,
          failed: res.failureCount,
        });
        await snap.ref.update({ reminderAt: null });
      } catch (err) {
        // Leave reminderAt in place so the next run retries this task.
        logger.error("Reminder send failed", { task: snap.id, error: String(err) });
      }
    }
  },
);
