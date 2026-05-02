import app from "./app";
import { config } from "./config";
import { logger, cleanupOldLogs } from "./utils/logger";
import { ensureAbortIncompleteMultipartLifecycle } from "./services/storage.service";
import { cleanupExpiredRooms } from "./services/room.service";
import { cleanupExpiredSnippets } from "./services/text.service";

// --------------------------------------
// Start server
// --------------------------------------

app.listen(config.PORT, () => {
  logger.info(`PandaShare API running on http://localhost:${config.PORT}`);
  logger.info(`S3 endpoint: ${config.S3_ENDPOINT || "not configured"}`);
  logger.info(`Database: ${config.DATABASE_URL ? "connected" : "not configured"}`);

  // Set S3 lifecycle rule to auto-abort incomplete multipart uploads after 1 day.
  ensureAbortIncompleteMultipartLifecycle().catch((err) => {
    logger.warn("Could not set S3 lifecycle rule", { error: (err as Error).message });
  });
 
  // Periodic cleanup for expired rooms and snippets runs immediately then every 15 minutes.
  const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

  async function runCleanup() {
    try {
      // Clean up expired rooms (and their S3 files)
      const roomResults = await cleanupExpiredRooms();
      if (roomResults.deleted > 0) {
        logger.info(`Cleanup: deleted ${roomResults.deleted} expired room(s)`);
      }
      for (const { roomId, error } of roomResults.errors) {
        logger.warn(`Cleanup: failed to delete room`, { roomId, error: error.message });
      }

      // Clean up expired text snippets
      const snippetResults = await cleanupExpiredSnippets();
      if (snippetResults.deleted > 0) {
        logger.info(`Cleanup: deleted ${snippetResults.deleted} expired snippet(s)`);
      }
      for (const { snippetId, error } of snippetResults.errors) {
        logger.warn(`Cleanup: failed to delete snippet`, { snippetId, error: error.message });
      }

      // Clean up old log files (keep only LOG_RETENTION_DAYS)
      await cleanupOldLogs();
    } catch (err) {
      logger.error("Cleanup: unexpected error", { error: (err as Error).message });
    }
  }

  runCleanup();
  setInterval(runCleanup, CLEANUP_INTERVAL_MS);
});
