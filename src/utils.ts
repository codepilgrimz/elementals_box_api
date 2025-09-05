import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// __dirname workaround in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logFile = path.join(__dirname, "prize_log.txt");
const countFile = path.join(__dirname, "log_count.txt");

// read last count from file
async function getLastCount() {
  try {
    const data = await fs.readFile(countFile, "utf8");
    return parseInt(data, 10) || 0;
  } catch {
    return 0; // file doesn't exist yet
  }
}

// save current count to file
async function saveCount(count: number) {
  await fs.writeFile(countFile, count.toString(), "utf8");
}

// log function
export async function logPrize(prize: any) {
  let logCount = await getLastCount();
  logCount++;

  const time = new Date().toISOString();
  const logLine = `[${logCount}] ${time} | prize: ${JSON.stringify(prize)}\n`;

  await fs.appendFile(logFile, logLine, "utf8");
  await saveCount(logCount);

  console.log(logLine.trim());
}

// --- Example usage ---
(async () => {
  await logPrize({ kind: "NFT", label: "Elementals NFT" });
  await logPrize({ kind: "SOL", lamports: 0.5 * 1e9, label: "0.5 SOL" });
})();
