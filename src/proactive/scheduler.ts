import cron from "node-cron"
import { notify } from "./notifier"

async function morningDebrief(): Promise<void> {
  console.log("Running morning debrief...")
  // TODO Phase 5: add weather, calendar, tasks, and OctoPrint status
  await notify(
    "Good morning",
    "Your morning debrief is ready. Say 'good morning' to Ixa to get started.",
    "default"
  )
}

export function startScheduler(): void {
  try {
    cron.schedule("0 8 * * 1-5", () => {
      morningDebrief().catch((err) => {
        console.error("Morning debrief failed:", err)
      })
    })
    console.log("Scheduler started — morning debrief at 8:00 AM weekdays")
  } catch (err) {
    console.error("Scheduler failed to start:", err)
  }
}
