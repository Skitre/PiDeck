/**
 * verify:docs — check local markdown links resolve on disk.
 * Fails on missing targets (broken internal links).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mdRoots = [
  join(root, "docs"),
  join(root, "README.md"),
  join(root, "THIRD_PARTY_NOTICES.md"),
];

const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
const errors = [];
let checked = 0;

function walkMd(path) {
  if (statSync(path).isFile()) {
    if (extname(path) === ".md") checkFile(path);
    return;
  }
  for (const name of readdirSync(path)) {
    if (name === "node_modules" || name === "target" || name === "dist") continue;
    walkMd(join(path, name));
  }
}

function checkFile(file) {
  const text = readFileSync(file, "utf8");
  let m;
  while ((m = linkRe.exec(text))) {
    const href = m[2].trim();
    if (!href || href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:")) {
      continue;
    }
    if (href.startsWith("#")) continue;
    const [pathPart] = href.split("#");
    if (!pathPart) continue;
    const target = resolve(dirname(file), pathPart);
    checked += 1;
    if (!existsSync(target)) {
      errors.push(`${file}: broken link -> ${href} (resolved ${target})`);
    }
  }
}

for (const p of mdRoots) {
  if (existsSync(p)) walkMd(p);
}

// Explicit contract paths that must exist
for (const rel of [
  "docs/README.md",
  "docs/operations/p0-scope.md",
  "docs/operations/p0-status.json",
  "docs/operations/remediation-report.md",
]) {
  checked += 1;
  if (!existsSync(join(root, rel))) {
    errors.push(`missing required file: ${rel}`);
  }
}

// Completion claims are authorized only by tracked release status. Ignored
// local artifacts are evidence outputs, not mutable documentation authority.
let p0GatePassed = false;
try {
  const status = JSON.parse(
    readFileSync(join(root, "docs", "operations", "p0-status.json"), "utf8"),
  );
  const completionClaimed = status.claimStatus === "complete";
  p0GatePassed =
    status.schemaVersion === 1 &&
    completionClaimed &&
    typeof status.acceptedRelease?.commit === "string" &&
    /^[0-9a-f]{40}$/i.test(status.acceptedRelease.commit) &&
    ["core", "full"].includes(status.acceptedRelease?.profile) &&
    status.acceptedRelease?.candidateBound === true &&
    status.acceptedRelease?.p0Complete === true &&
    typeof status.acceptedRelease?.evidencePath === "string";
  if (completionClaimed && !p0GatePassed) {
    errors.push("docs/operations/p0-status.json: incomplete accepted release claim");
  }
} catch {
  errors.push("docs/operations/p0-status.json: invalid tracked P0 status");
}
const statusFiles = [
  join(root, "docs/operations/remediation-report.md"),
  join(root, "docs/README.md"),
  join(root, "README.md"),
];
const forbiddenComplete = [
  /R0-R7\s+(skeptic\s+)?gaps\s+closed/i,
  /P0\s+(is\s+)?complete/i,
  /Windows\s+release\s+(is\s+)?complete/i,
  /M0-M6\s+(all\s+)?complete/i,
];
for (const f of statusFiles) {
  if (!existsSync(f)) continue;
  const text = readFileSync(f, "utf8");
  // Allow explicit "Not Complete" / "not complete" denial phrases
  for (const re of forbiddenComplete) {
    if (re.test(text) && !/not\s+complete|P0\s+Not\s+Complete/i.test(text)) {
      if (!p0GatePassed) {
        errors.push(`${f}: forbidden completion claim matching ${re} (P0 claimStatus is not complete)`);
      }
    }
  }
  if (
    /R0-R7.*closed/i.test(text) &&
    !/Partial|Not Complete|Not Implemented/i.test(text) &&
    !p0GatePassed
  ) {
    errors.push(`${f}: must not imply R0-R7 closed without Partial/Not Complete status`);
  }
}

console.log(`verify:docs checked=${checked} errors=${errors.length}`);
if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log("verify:docs OK");
