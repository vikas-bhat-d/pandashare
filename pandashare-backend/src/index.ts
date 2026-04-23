import app from "./app";
import { config } from "./config";
import { ensureAbortIncompleteMultipartLifecycle } from "./services/storage.service";
import { cleanupExpiredRooms } from "./services/room.service";

// --------------------------------------
// Start server
// --------------------------------------

app.listen(config.PORT, () => {
  console.log(`\n  ?? PandaShare API running on http://localhost:${config.PORT}`);
  console.log(`  ?? S3 endpoint: ${config.S3_ENDPOINT}`);
  console.log(`  ???  Database: ${config.DATABASE_URL ? "connected" : "not configured"}\n`);

  // Set S3 lifecycle rule to auto-abort incomplete multipart uploads after 1 day.
  ensureAbortIncompleteMultipartLifecycle().catch((err) => {
    console.warn("  ??  Could not set S3 lifecycle rule:", (err as Error).message);
  });

  // Periodic expired-room cleanup — runs immediately then every 15 minutes.
  const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

  async function runCleanup() {
    try {
      const { deleted, errors } = await cleanupExpiredRooms();
      if (deleted > 0) {
        console.log(`  ???  Cleanup: deleted ${deleted} expired room(s).`);
      }
      for (const { roomId, error } of errors) {
        console.warn(`  ??  Cleanup: failed to delete room ${roomId}:`, error.message);
      }
    } catch (err) {
      console.warn("  ??  Cleanup: unexpected error:", (err as Error).message);
    }
  }

  runCleanup();
  setInterval(runCleanup, CLEANUP_INTERVAL_MS);
});
