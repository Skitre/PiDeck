import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_PRODUCT = "Pi Desktop Manager";
const NSIS_MARKER = "Nullsoft.NSIS.exehead";
const MAX_NSIS_MARKER_OFFSET = 256 * 1024;
const PROBE_BYTES = 2 * 1024 * 1024;
const IOC_STRINGS = [
  "Synaptics Pointing Device Driver",
  "Synaptics.exe",
  "Synaptics.dll",
  "Injecting ->",
];

function findText(buffer, text) {
  const ascii = buffer.indexOf(Buffer.from(text, "ascii"));
  const utf16le = buffer.indexOf(Buffer.from(text, "utf16le"));
  return { ascii, utf16le };
}

function readVersionInfo(path) {
  if (process.platform !== "win32") {
    return { ok: false, error: "Windows VersionInfo inspection requires win32" };
  }
  const escaped = resolve(path).replace(/'/g, "''");
  const command =
    `$v = (Get-Item -LiteralPath '${escaped}').VersionInfo; ` +
    "[ordered]@{ " +
    "FileDescription = $v.FileDescription; " +
    "ProductName = $v.ProductName; " +
    "FileVersion = $v.FileVersion; " +
    "ProductVersion = $v.ProductVersion; " +
    "CompanyName = $v.CompanyName; " +
    "OriginalFilename = $v.OriginalFilename " +
    "} | ConvertTo-Json -Compress";
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", shell: false, timeout: 30_000 },
  );
  if (result.status !== 0 || result.error) {
    return {
      ok: false,
      error: result.error?.message || result.stderr?.trim() || `PowerShell exit ${result.status}`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `invalid VersionInfo JSON: ${error.message}` };
  }
}

export function inspectWindowsInstaller(path) {
  const errors = [];
  if (!existsSync(path)) {
    return { ok: false, path: resolve(path), errors: ["installer does not exist"] };
  }

  const stat = statSync(path);
  const buffer = readFileSync(path);
  if (buffer.length < 512 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    errors.push("installer is not an MZ executable");
  }

  let peOffset = null;
  if (buffer.length >= 0x40) {
    peOffset = buffer.readUInt32LE(0x3c);
    if (
      peOffset < 0x40 ||
      peOffset + 4 > buffer.length ||
      buffer.subarray(peOffset, peOffset + 4).compare(Buffer.from("PE\0\0", "binary")) !== 0
    ) {
      errors.push("installer has an invalid outer PE header");
    }
  }

  const probe = buffer.subarray(0, Math.min(buffer.length, PROBE_BYTES));
  const nsis = findText(probe, NSIS_MARKER);
  const nsisMarkerOffset = [nsis.ascii, nsis.utf16le].filter((value) => value >= 0).sort((a, b) => a - b)[0] ?? -1;
  if (nsisMarkerOffset < 0) {
    errors.push("outer PE does not contain the NSIS executable-head marker");
  } else if (nsisMarkerOffset > MAX_NSIS_MARKER_OFFSET) {
    errors.push(
      `NSIS executable-head marker is embedded too deep (${nsisMarkerOffset} bytes); refusing a wrapped installer`,
    );
  }

  const iocMatches = [];
  for (const indicator of IOC_STRINGS) {
    const match = findText(probe, indicator);
    if (match.ascii >= 0 || match.utf16le >= 0) {
      iocMatches.push({ indicator, ...match });
    }
  }
  if (iocMatches.length > 0) {
    errors.push(`installer contains rejected indicators: ${iocMatches.map((match) => match.indicator).join(", ")}`);
  }

  const version = readVersionInfo(path);
  if (!version.ok) {
    errors.push(`could not inspect outer PE VersionInfo: ${version.error}`);
  } else {
    if (version.value.ProductName !== EXPECTED_PRODUCT) {
      errors.push(`outer PE ProductName is ${JSON.stringify(version.value.ProductName)}, expected ${JSON.stringify(EXPECTED_PRODUCT)}`);
    }
    if (version.value.FileDescription !== EXPECTED_PRODUCT) {
      errors.push(
        `outer PE FileDescription is ${JSON.stringify(version.value.FileDescription)}, expected ${JSON.stringify(EXPECTED_PRODUCT)}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    path: resolve(path),
    size: stat.size,
    peOffset,
    nsisMarkerOffset,
    maxAcceptedNsisMarkerOffset: MAX_NSIS_MARKER_OFFSET,
    expectedProduct: EXPECTED_PRODUCT,
    versionInfo: version.ok ? version.value : null,
    versionInfoError: version.ok ? null : version.error,
    iocMatches,
    errors,
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node scripts/windows-installer-integrity.mjs <setup.exe>");
    process.exit(2);
  }
  const report = inspectWindowsInstaller(path);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
