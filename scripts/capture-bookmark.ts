/**
 * Capture D1 Time Travel bookmark before deployment
 *
 * This script records the current timestamp before migrations run,
 * providing a known restore point for rollbacks.
 *
 * Usage: npx tsx scripts/capture-bookmark.ts
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";

interface DeploymentRecord {
  timestamp: string;
  bookmark?: string;
  gitCommit?: string;
  gitBranch?: string;
}

interface DeploymentsLog {
  deployments: DeploymentRecord[];
}

const LOG_FILE = "deployments.json";

function getCurrentGitInfo(): { commit?: string; branch?: string } {
  try {
    const commit = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
    return { commit, branch };
  } catch {
    return {};
  }
}

function getBookmark(timestamp: string): string | undefined {
  try {
    const output = execSync(
      `npx wrangler d1 time-travel info DB --timestamp="${timestamp}" --json`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const data = JSON.parse(output);
    return data.bookmark;
  } catch {
    // Bookmark retrieval is optional - timestamp is sufficient for restore
    return undefined;
  }
}

function loadLog(): DeploymentsLog {
  if (existsSync(LOG_FILE)) {
    try {
      return JSON.parse(readFileSync(LOG_FILE, "utf-8"));
    } catch {
      return { deployments: [] };
    }
  }
  return { deployments: [] };
}

function saveLog(log: DeploymentsLog): void {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2) + "\n");
}

// Main
const timestamp = new Date().toISOString();
const gitInfo = getCurrentGitInfo();
const bookmark = getBookmark(timestamp);

const record: DeploymentRecord = {
  timestamp,
  ...(bookmark && { bookmark }),
  ...(gitInfo.commit && { gitCommit: gitInfo.commit }),
  ...(gitInfo.branch && { gitBranch: gitInfo.branch }),
};

const log = loadLog();
log.deployments.push(record);

// Keep last 50 deployments
if (log.deployments.length > 50) {
  log.deployments = log.deployments.slice(-50);
}

saveLog(log);

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("D1 Pre-Deployment Bookmark Captured");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`Timestamp: ${timestamp}`);
if (bookmark) console.log(`Bookmark:  ${bookmark}`);
if (gitInfo.commit) console.log(`Commit:    ${gitInfo.commit} (${gitInfo.branch})`);
console.log("");
console.log("To rollback:");
console.log(`  npx wrangler d1 time-travel restore DB --timestamp="${timestamp}"`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
