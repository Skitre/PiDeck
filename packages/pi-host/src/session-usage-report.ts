import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  SerializableUsage,
  SessionUsageReport,
  SessionUsageReportItem,
} from "@pideck/protocol";
import { sessionStorageDirs } from "./session-storage.js";

type CachedSessionUsage = {
  mtimeMs: number;
  size: number;
  item: SessionUsageReportItem;
};

const usageCache = new Map<string, CachedSessionUsage>();

function emptyUsage(): SerializableUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function token(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function cost(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function addUsage(target: SerializableUsage, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const usage = value as Record<string, unknown>;
  target.input += token(usage.input);
  target.output += token(usage.output);
  target.cacheRead += token(usage.cacheRead);
  target.cacheWrite += token(usage.cacheWrite);
  target.totalTokens += token(usage.totalTokens);

  if (usage.cacheWrite1h !== undefined) {
    target.cacheWrite1h = (target.cacheWrite1h ?? 0) + token(usage.cacheWrite1h);
  }
  if (usage.reasoning !== undefined) {
    target.reasoning = (target.reasoning ?? 0) + token(usage.reasoning);
  }

  if (!usage.cost || typeof usage.cost !== "object" || Array.isArray(usage.cost)) return;
  const usageCost = usage.cost as Record<string, unknown>;
  target.cost.input += cost(usageCost.input);
  target.cost.output += cost(usageCost.output);
  target.cost.cacheRead += cost(usageCost.cacheRead);
  target.cost.cacheWrite += cost(usageCost.cacheWrite);
  target.cost.total += cost(usageCost.total);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

async function parseSessionFile(
  sessionPath: string,
  archived: boolean,
  mtimeMs: number,
): Promise<SessionUsageReportItem | null> {
  let sessionId: string | null = null;
  let name: string | undefined;
  let messageCount = 0;
  const usage = emptyUsage();

  const lines = createInterface({
    input: createReadStream(sessionPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    if (entry.type === "session" && sessionId === null && isUuid(entry.id)) {
      sessionId = entry.id;
      continue;
    }
    if (entry.type === "session_info") {
      name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
      continue;
    }
    if (entry.type !== "message") continue;
    messageCount += 1;
    if (!entry.message || typeof entry.message !== "object" || Array.isArray(entry.message)) {
      continue;
    }
    const message = entry.message as Record<string, unknown>;
    if (message.role === "assistant") addUsage(usage, message.usage);
  }

  if (!sessionId) return null;
  return {
    sessionId,
    sessionPath,
    ...(name ? { name } : {}),
    updatedAt: mtimeMs,
    archived,
    messageCount,
    usage,
  };
}

async function scanDirectory(
  dir: string,
  archived: boolean,
  seen: Set<string>,
): Promise<SessionUsageReportItem[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const files = entries.filter(
    (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl"),
  );
  const items: Array<SessionUsageReportItem | null> = [];
  for (let offset = 0; offset < files.length; offset += 8) {
    const batch = await Promise.all(
      files.slice(offset, offset + 8).map(async (entry) => {
        const sessionPath = join(dir, entry.name);
        seen.add(sessionPath);
        const fileStat = await stat(sessionPath);
        const cached = usageCache.get(sessionPath);
        if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
          return cached.item;
        }
        const item = await parseSessionFile(sessionPath, archived, fileStat.mtimeMs);
        if (item) {
          usageCache.set(sessionPath, {
            mtimeMs: fileStat.mtimeMs,
            size: fileStat.size,
            item,
          });
        } else {
          usageCache.delete(sessionPath);
        }
        return item;
      }),
    );
    items.push(...batch);
  }
  return items.filter((item): item is SessionUsageReportItem => item !== null);
}

export async function buildSessionUsageReport(args: {
  agentDir: string;
  canonicalCwd: string;
  workspaceId: string;
}): Promise<SessionUsageReport> {
  const dirs = sessionStorageDirs(args.agentDir, args.canonicalCwd);
  const seen = new Set<string>();
  const [active, archived] = await Promise.all([
    scanDirectory(dirs.activeDir, false, seen),
    scanDirectory(dirs.archiveDir, true, seen),
  ]);
  for (const path of usageCache.keys()) {
    if (
      !seen.has(path) &&
      (path.startsWith(dirs.activeDir) || path.startsWith(dirs.archiveDir))
    ) {
      usageCache.delete(path);
    }
  }

  const sessions = [...active, ...archived].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  const totalsUsage = emptyUsage();
  let messageCount = 0;
  for (const session of sessions) {
    messageCount += session.messageCount;
    addUsage(totalsUsage, session.usage);
  }

  return {
    workspaceId: args.workspaceId,
    generatedAt: Date.now(),
    totals: {
      sessionCount: sessions.length,
      messageCount,
      usage: totalsUsage,
    },
    sessions,
  };
}
