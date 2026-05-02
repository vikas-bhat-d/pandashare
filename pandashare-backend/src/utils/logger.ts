import fs from "fs/promises";
import path from "path";
import { config } from "../config";

/**
 * Simple structured logger for PandaShare.
 * Logs to console with [LEVEL] prefix and optionally to a log file.
 */

const LOG_DIR = process.env.LOG_DIR || "logs";
const ENABLE_FILE_LOGGING = process.env.ENABLE_FILE_LOGGING !== "false";

let initialized = false;

async function ensureLogDir() {
  if (!ENABLE_FILE_LOGGING || initialized) return;
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    initialized = true;
  } catch (err) {
    console.error("[ERROR] Failed to create log directory:", (err as Error).message);
  }
}

async function writeLog(level: string, message: string, meta?: any) {
  if (!ENABLE_FILE_LOGGING) return;

  await ensureLogDir();

  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...(meta && { meta }),
  };

  const logFile = path.join(LOG_DIR, `pandashare-${new Date().toISOString().split("T")[0]}.log`);

  try {
    await fs.appendFile(logFile, JSON.stringify(logEntry) + "\n", "utf-8");
  } catch (err) {
    console.error("[ERROR] Failed to write log file:", (err as Error).message);
  }
}

export const logger = {
  info: (message: string, meta?: any) => {
    console.log(`[INFO] ${message}`, meta ? meta : "");
    writeLog("INFO", message, meta).catch(() => {});
  },

  warn: (message: string, meta?: any) => {
    console.warn(`[WARN] ${message}`, meta ? meta : "");
    writeLog("WARN", message, meta).catch(() => {});
  },

  error: (message: string, meta?: any) => {
    console.error(`[ERROR] ${message}`, meta ? meta : "");
    writeLog("ERROR", message, meta).catch(() => {});
  },

  debug: (message: string, meta?: any) => {
    if (process.env.DEBUG === "true") {
      console.log(`[DEBUG] ${message}`, meta ? meta : "");
      writeLog("DEBUG", message, meta).catch(() => {});
    }
  },
};

/**
 * Delete log files older than LOG_RETENTION_DAYS.
 * Called periodically from the cleanup cycle to prevent disk space overflow.
 */
export async function cleanupOldLogs(): Promise<number> {
  if (!ENABLE_FILE_LOGGING) return 0;

  try {
    await ensureLogDir();
    const files = await fs.readdir(LOG_DIR);
    const logFiles = files.filter((f) => f.endsWith(".log"));

    const retentionMs = config.LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const cutoffTime = Date.now() - retentionMs;
    let deletedCount = 0;

    for (const file of logFiles) {
      const filePath = path.join(LOG_DIR, file);
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs < cutoffTime) {
          await fs.unlink(filePath);
          deletedCount++;
        }
      } catch (err) {
        logger.warn(`Failed to delete old log file ${file}`, { error: (err as Error).message });
      }
    }

    if (deletedCount > 0) {
      logger.info(`Deleted ${deletedCount} old log file(s)`);
    }

    return deletedCount;
  } catch (err) {
    logger.error("Failed to cleanup old logs", { error: (err as Error).message });
    return 0;
  }
}
