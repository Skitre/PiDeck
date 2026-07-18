import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "artifacts", "p0", "e2e-latest");
const releaseExe = join(
  root,
  "apps/desktop/src-tauri/target/release/pi-desktop.exe",
);
const exe = process.env.PI_DESKTOP_E2E_EXE || releaseExe;
const releaseManifestPath = join(
  root,
  "apps/desktop/src-tauri/target/release-staging/PACKAGE_RELEASE.json",
);
const fixturePackage = join(
  root,
  "test-fixtures/pi-packages/full-package",
);
const uiFixturePackage = join(
  root,
  "test-fixtures/pi-packages/ui-extension",
);
const workflowMode = process.env.PI_DESKTOP_E2E_MODE === "m0" ? "m0" : "full";
mkdirSync(resultsDir, { recursive: true });

const steps = [];
let desktop = null;
let gitDaemon = null;
let browser = null;
let page = null;
let profileRoot = null;
let seededSettingsPath = null;
let seededTrustPath = null;
let uiMarkerPath = null;
let npmFixtureSource = null;
let gitFixtureSource = null;
const uiNonce = randomUUID();
let stderr = "";
let cleanupComplete = false;
const browserConsole = [];
const pageErrors = [];

function writeResult(body) {
  const result = {
    gate: "test:e2e",
    mode: "tauri-webview2-cdp",
    workflowMode,
    finishedAt: new Date().toISOString(),
    executable: exe,
    steps,
    ...body,
  };
  writeFileSync(
    join(resultsDir, "e2e-results.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function fail(message, extra = {}) {
  writeResult({ ok: false, status: "failed", message, ...extra });
  process.exitCode = 1;
}

function record(step, details = {}) {
  steps.push({ step, ok: true, ...details });
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function expectedExecutableSha256() {
  if (process.env.PI_DESKTOP_E2E_EXPECTED_SHA256) {
    return process.env.PI_DESKTOP_E2E_EXPECTED_SHA256.toLowerCase();
  }
  if (!existsSync(releaseManifestPath)) {
    throw new Error(`release candidate manifest missing: ${releaseManifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(releaseManifestPath, "utf8"));
  if (
    manifest.status !== "ok" ||
    resolve(manifest.desktopExecutable ?? "") !== resolve(exe) ||
    typeof manifest.desktopExecutableSha256 !== "string"
  ) {
    throw new Error("release candidate manifest does not bind the selected executable");
  }
  return manifest.desktopExecutableSha256.toLowerCase();
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate CDP port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForCdp(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `WebView2 CDP endpoint did not become ready: ${lastError instanceof Error ? lastError.message : "timeout"}`,
  );
}

async function waitForUnchecked(locator, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await locator.isChecked())) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("resource disable did not converge");
}

async function waitForFile(path, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for file: ${path}`);
}

function writeDesktopSettings(configDir, projectDir, agentDir) {
  const settings = {
    theme: "dark",
    defaultWorkspace: projectDir,
    restoreLastSession: true,
    lastWorkspace: projectDir,
    agentDir,
    autoRestartHostOnce: true,
  };
  mkdirSync(configDir, { recursive: true });
  const settingsPath = join(configDir, "desktop-settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return settingsPath;
}

async function collectFailureDiagnostics() {
  const diagnostics = {
    profileRoot,
    seededSettingsPath,
    seededSettings: seededSettingsPath && existsSync(seededSettingsPath)
      ? JSON.parse(readFileSync(seededSettingsPath, "utf8"))
      : null,
    seededTrustPath,
    seededTrust: seededTrustPath && existsSync(seededTrustPath)
      ? JSON.parse(readFileSync(seededTrustPath, "utf8"))
      : null,
    desktopPid: desktop?.pid ?? null,
    desktopExitCode: desktop?.exitCode ?? null,
    stderrTail: stderr,
    browserConsole,
    pageErrors,
  };

  if (!page || page.isClosed()) return diagnostics;

  try {
    diagnostics.url = page.url();
    diagnostics.title = await page.title();
    diagnostics.bodyText = (await page.locator("body").innerText()).slice(0, 20_000);
  } catch (error) {
    diagnostics.pageReadError = error instanceof Error ? error.message : String(error);
  }

  try {
    diagnostics.tauri = await page.evaluate(async () => {
      const invoke = globalThis.__TAURI_INTERNALS__?.invoke;
      if (typeof invoke !== "function") {
        return { available: false };
      }
      const [settings, hostRunning] = await Promise.all([
        invoke("desktop_settings_get").catch((error) => ({ error: String(error) })),
        invoke("pi_host_status").catch((error) => ({ error: String(error) })),
      ]);
      return { available: true, settings, hostRunning };
    });
  } catch (error) {
    diagnostics.tauri = { available: false, error: error instanceof Error ? error.message : String(error) };
  }

  try {
    const screenshotPath = join(resultsDir, "desktop-e2e-failure.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    diagnostics.screenshot = screenshotPath;
  } catch (error) {
    diagnostics.screenshotError = error instanceof Error ? error.message : String(error);
  }

  return diagnostics;
}

function stopGitDaemon() {
  if (!gitDaemon?.pid || gitDaemon.exitCode !== null) {
    return { attempted: false, status: 0, error: null };
  }
  const result = spawnSync("taskkill", ["/PID", String(gitDaemon.pid), "/T", "/F"], {
    shell: false,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    attempted: true,
    status: result.status,
    error: result.error?.message ?? null,
  };
}

function killDesktopTree() {
  if (!desktop?.pid || desktop.exitCode !== null) {
    return { attempted: false, status: 0, error: null };
  }
  const result = spawnSync("taskkill", ["/PID", String(desktop.pid), "/T", "/F"], {
    shell: false,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    attempted: true,
    status: result.status,
    error: result.error?.message ?? null,
  };
}

function closeDesktopWindow() {
  if (!desktop?.pid || desktop.exitCode !== null) return;
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `$p=Get-Process -Id ${desktop.pid} -ErrorAction Stop; if (-not $p.CloseMainWindow()) { throw 'CloseMainWindow returned false' }`,
    ],
    { shell: false, encoding: "utf8", timeout: 15_000 },
  );
  if (result.status !== 0 || result.error) {
    throw new Error(
      `failed to close desktop window: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
    );
  }
}

async function waitForDesktopExit(timeoutMs = 15_000) {
  if (!desktop || desktop.exitCode !== null) return desktop?.exitCode ?? 0;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("desktop did not exit after window close")), timeoutMs);
    desktop.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });
}

function auditRuntimeProcesses() {
  const escapedRoot = dirname(exe).replace(/'/g, "''");
  const audit = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `$root='${escapedRoot}'; $p=Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','npm.exe','git.exe','pi-desktop.exe') -and $_.CommandLine -like ('*'+$root+'*') }; $p | Select-Object Name,ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`,
    ],
    { shell: false, encoding: "utf8", timeout: 15_000 },
  );
  const output = (audit.stdout || "").trim();
  return {
    status: audit.status,
    error: audit.error?.message ?? null,
    output,
    clear: audit.status === 0 && !audit.error && (output === "" || output === "null"),
  };
}

async function cleanup(force = true) {
  try {
    await browser?.close();
  } catch {
    /* connection may already be closed by the native window */
  }
  const forcedTermination = force ? killDesktopTree() : { attempted: false, status: 0, error: null };
  const gitDaemonTermination = stopGitDaemon();
  if (forcedTermination.attempted || gitDaemonTermination.attempted) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const audit = auditRuntimeProcesses();
  if (profileRoot) {
    try {
      rmSync(profileRoot, { recursive: true, force: true });
    } catch {
      /* reported through the process audit rather than hidden as success */
    }
  }
  return { forcedTermination, gitDaemonTermination, audit };
}

try {
  if (process.platform !== "win32") {
    throw new Error("desktop E2E requires Windows 11 x64");
  }
  if (!existsSync(exe)) {
    throw new Error(`release desktop executable missing: ${exe}`);
  }
  if (!existsSync(fixturePackage)) {
    throw new Error(`controlled Package fixture missing: ${fixturePackage}`);
  }
  if (!existsSync(uiFixturePackage)) {
    throw new Error(`controlled Extension UI fixture missing: ${uiFixturePackage}`);
  }
  const expectedSha256 = expectedExecutableSha256();
  const executableSha256 = fileSha256(exe);
  if (executableSha256 !== expectedSha256) {
    throw new Error(
      `desktop executable hash mismatch: expected ${expectedSha256}, got ${executableSha256}`,
    );
  }
  record("desktop.candidate.verified", { executableSha256 });

  profileRoot = mkdtempSync(join(tmpdir(), "pi-desktop-e2e-"));
  const userProfile = join(profileRoot, "user");
  const appData = join(userProfile, "AppData", "Roaming");
  const localAppData = join(userProfile, "AppData", "Local");
  const configDir = join(profileRoot, "desktop-config");
  const agentDir = join(profileRoot, "agent");
  const projectDir = join(profileRoot, "workspace");
  const webviewData = join(profileRoot, "webview2");
  for (const dir of [userProfile, appData, localAppData, configDir, agentDir, projectDir, webviewData]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const name of ["auth.json", "models.json", "settings.json"]) {
    writeFileSync(join(agentDir, name), "{}\n");
  }
  seededTrustPath = join(agentDir, "trust.json");
  writeFileSync(seededTrustPath, "{}\n");
  uiMarkerPath = join(profileRoot, "ui-extension-marker.txt");
  seededSettingsPath = writeDesktopSettings(configDir, projectDir, agentDir);

  if (workflowMode === "full") {
    const resourcesDir = join(dirname(exe), "resources");
    const bundledNode = join(resourcesDir, "node", "node.exe");
    const npmCli = join(resourcesDir, "node", "node_modules", "npm", "bin", "npm-cli.js");
    const bundledGit = join(resourcesDir, "git", "cmd", "git.exe");
    for (const path of [bundledNode, npmCli, bundledGit]) {
      if (!existsSync(path)) throw new Error(`controlled package fixture tool missing: ${path}`);
    }
    const controlledPath = [
      join(resourcesDir, "node"),
      join(resourcesDir, "git", "cmd"),
      join(resourcesDir, "git", "bin"),
      `${process.env.SystemRoot}\\System32`,
    ].join(";");
    const toolEnv = { ...process.env, PATH: controlledPath, NODE_OPTIONS: "" };

    const npmFixtureDir = join(profileRoot, "npm-fixture");
    const npmPackDir = join(profileRoot, "npm-pack");
    cpSync(fixturePackage, npmFixtureDir, { recursive: true });
    mkdirSync(npmPackDir, { recursive: true });
    const npmPackageJsonPath = join(npmFixtureDir, "package.json");
    const npmPackageJson = JSON.parse(readFileSync(npmPackageJsonPath, "utf8"));
    npmPackageJson.name = "pi-desktop-npm-fixture";
    writeFileSync(npmPackageJsonPath, JSON.stringify(npmPackageJson, null, 2));
    const npmPack = spawnSync(
      bundledNode,
      [npmCli, "pack", "--json", "--pack-destination", npmPackDir],
      {
        cwd: npmFixtureDir,
        shell: false,
        encoding: "utf8",
        timeout: 120_000,
        env: toolEnv,
      },
    );
    if (npmPack.status !== 0 || npmPack.error) {
      throw new Error(`controlled npm pack failed: ${npmPack.error?.message ?? npmPack.stderr}`);
    }
    const npmPackResult = JSON.parse(npmPack.stdout);
    const npmTarball = join(npmPackDir, npmPackResult[0].filename);
    npmFixtureSource = `npm:file:${npmTarball.replace(/\\/g, "/")}`;

    const gitWorkDir = join(profileRoot, "git-work", "pi-desktop-git-fixture");
    const gitServeRoot = join(profileRoot, "git-serve");
    const gitBareDir = join(gitServeRoot, "owner", "pi-desktop-git-fixture.git");
    cpSync(fixturePackage, gitWorkDir, { recursive: true });
    mkdirSync(dirname(gitBareDir), { recursive: true });
    const gitPackageJsonPath = join(gitWorkDir, "package.json");
    const gitPackageJson = JSON.parse(readFileSync(gitPackageJsonPath, "utf8"));
    gitPackageJson.name = "pi-desktop-git-fixture";
    writeFileSync(gitPackageJsonPath, JSON.stringify(gitPackageJson, null, 2));
    for (const args of [
      ["init"],
      ["config", "user.email", "p0@example.invalid"],
      ["config", "user.name", "PiDesktop P0"],
      ["add", "."],
      ["commit", "-m", "controlled fixture"],
    ]) {
      const git = spawnSync(bundledGit, args, {
        cwd: gitWorkDir,
        shell: false,
        encoding: "utf8",
        timeout: 60_000,
        env: toolEnv,
      });
      if (git.status !== 0 || git.error) {
        throw new Error(`controlled git fixture failed (${args.join(" ")}): ${git.error?.message ?? git.stderr}`);
      }
    }
    const cloneBare = spawnSync(bundledGit, ["clone", "--bare", gitWorkDir, gitBareDir], {
      cwd: profileRoot,
      shell: false,
      encoding: "utf8",
      timeout: 60_000,
      env: toolEnv,
    });
    if (cloneBare.status !== 0 || cloneBare.error) {
      throw new Error(`controlled bare git fixture failed: ${cloneBare.error?.message ?? cloneBare.stderr}`);
    }
    const gitPort = await freePort();
    gitDaemon = spawn(
      bundledGit,
      [
        "daemon",
        "--reuseaddr",
        "--export-all",
        `--base-path=${gitServeRoot}`,
        "--listen=127.0.0.1",
        `--port=${gitPort}`,
        gitServeRoot,
      ],
      { cwd: gitServeRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: toolEnv },
    );
    await new Promise((resolve) => setTimeout(resolve, 750));
    if (gitDaemon.exitCode !== null) {
      throw new Error(`controlled git daemon exited early with ${gitDaemon.exitCode}`);
    }
    gitFixtureSource = `git://127.0.0.1:${gitPort}/owner/pi-desktop-git-fixture.git`;
    record("package.fixtures.prepared", {
      npmSource: npmFixtureSource,
      gitSource: gitFixtureSource,
    });
  }

  const port = await freePort();
  desktop = spawn(exe, [], {
    cwd: dirname(exe),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
    env: {
      ...process.env,
      USERPROFILE: userProfile,
      HOME: userProfile,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      PI_DESKTOP_CONFIG_DIR: configDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_DESKTOP_UI_MARKER: uiMarkerPath,
      PI_DESKTOP_UI_NONCE: uiNonce,
      WEBVIEW2_USER_DATA_FOLDER: webviewData,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });
  desktop.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8_000);
  });
  record("desktop.launch", { pid: desktop.pid, cdpPort: port });

  await waitForCdp(port, 60_000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error("no WebView2 browser context");
  page = context.pages()[0];
  if (!page) page = await context.waitForEvent("page", { timeout: 30_000 });
  page.on("console", (message) => {
    browserConsole.push({
      type: message.type(),
      text: message.text(),
    });
    if (browserConsole.length > 200) browserConsole.shift();
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
    if (pageErrors.length > 100) pageErrors.shift();
  });
  await page.waitForLoadState("domcontentloaded");
  await page.getByText("Pi Desktop Manager", { exact: true }).waitFor({ timeout: 30_000 });
  record("desktop.window.attached", { title: await page.title() });

  await page.getByText(projectDir, { exact: false }).first().waitFor({ timeout: 210_000 });
  await page.locator("textarea").last().waitFor({ timeout: 60_000 });
  record("workspace.session.rehydrated", { projectDir });

  await page.getByRole("button", { name: "Packages" }).click();
  const sourceInput = page.getByPlaceholder("npm:pkg | git:… | path");

  if (workflowMode === "full") {
    await sourceInput.fill(fixturePackage);
    await page.locator("select").filter({ has: page.locator('option[value="project"]') }).selectOption("project");
    await page.getByTitle("Install package").click();
    const trustDialog = page.getByRole("dialog", { name: "Trust project packages" });
    await trustDialog.waitFor({ timeout: 30_000 });
    await trustDialog.getByRole("button", { name: "Trust once" }).click();
    const confirmationDialog = page.getByRole("dialog", { name: "Confirm executable code" });
    await confirmationDialog.waitFor({ timeout: 60_000 });
    await confirmationDialog.getByRole("button", { name: "Continue" }).click();
    const installedPackageRow = page.getByRole("button", { name: /^full-package\b/i });
    await installedPackageRow.waitFor({ timeout: 180_000 });
    record("package.project-trust-confirm-install", { source: fixturePackage });

    await installedPackageRow.click();
    for (const heading of [/extensions/i, /skills/i, /prompts/i, /themes/i]) {
      await page.getByRole("heading", { name: heading }).waitFor({ timeout: 30_000 });
    }
    record("package.resources.four-types");

    const firstResourceToggle = page.locator('input[type="checkbox"]').first();
    await firstResourceToggle.click();
    await waitForUnchecked(firstResourceToggle);
    record("package.resource.disabled");

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Always trust" }).click();
    await page.getByText(/Decision:\s*trusted/i).waitFor({ timeout: 60_000 });
    record("workspace.trust.persisted");
    await page.getByRole("button", { name: "Restart Host" }).click();
    await page.getByText(projectDir, { exact: false }).first().waitFor({ timeout: 210_000 });
    await page.getByRole("button", { name: "Packages" }).click();
    await installedPackageRow.click();
    const persistedToggle = page.locator('input[type="checkbox"]').first();
    await persistedToggle.waitFor({ timeout: 60_000 });
    if (await persistedToggle.isChecked()) {
      throw new Error("resource disable was not preserved across Host restart");
    }
    record("host.restart.resource-persistence");

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTitle("Remove").click();
    await page.getByText("No packages. Install from npm, git, or a local path.").waitFor({
      timeout: 180_000,
    });
    record("package.remove");

    await page.locator("select").filter({ has: page.locator('option[value="project"]') }).selectOption("user");
    for (const [kind, source, rowName] of [
      ["npm", npmFixtureSource, /^pi-desktop-npm-fixture\b/i],
      ["git", gitFixtureSource, /^pi-desktop-git-fixture\b/i],
    ]) {
      if (!source) throw new Error(`${kind} fixture source was not prepared`);
      await sourceInput.fill(source);
      await page.getByTitle("Install package").click();
      const row = page.getByRole("button", { name: rowName });
      await row.waitFor({ timeout: 180_000 });
      record(`package.${kind}.install`, { source });
      await row.click();
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByTitle("Remove").click();
      await page.getByText("No packages. Install from npm, git, or a local path.").waitFor({
        timeout: 180_000,
      });
      record(`package.${kind}.remove`);
    }
  }

  await sourceInput.fill(uiFixturePackage);
  await page.locator("select").filter({ has: page.locator('option[value="project"]') }).selectOption("user");
  await page.getByTitle("Install package").click();
  const selectDialog = page.getByRole("dialog", { name: "Pick fixture option" });
  await selectDialog.waitFor({ timeout: 180_000 });
  await selectDialog.getByRole("button", { name: "beta" }).click();
  const confirmDialog = page.getByRole("dialog", { name: "Confirm fixture" });
  await confirmDialog.waitFor({ timeout: 60_000 });
  await confirmDialog.getByRole("button", { name: "Confirm" }).click();
  const inputDialog = page.getByRole("dialog", { name: "Fixture input" });
  await inputDialog.waitFor({ timeout: 60_000 });
  await inputDialog.locator("textarea").fill("typed-e2e");
  await inputDialog.getByRole("button", { name: "OK" }).click();
  const marker = await waitForFile(uiMarkerPath);
  if (
    !marker.includes("selected=beta") ||
    !marker.includes("confirmed=true") ||
    !marker.includes("typed=typed-e2e") ||
    !marker.includes("handler=session_start") ||
    !marker.includes(`nonce=${uiNonce}`) ||
    !marker.includes("invocationCount=1")
  ) {
    throw new Error(`Extension UI marker mismatch: ${marker}`);
  }
  const uiPackageRow = page.getByRole("button", { name: /^pi-desktop-ui-extension-fixture\b/i });
  await uiPackageRow.waitFor({ timeout: 180_000 });
  record("extension-ui.release-path", {
    source: uiFixturePackage,
    nonce: uiNonce,
    invocationCount: 1,
  });

  await uiPackageRow.click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTitle("Remove").click();
  await page.getByText("No packages. Install from npm, git, or a local path.").waitFor({
    timeout: 180_000,
  });
  record("extension-ui.package.remove");

  if (workflowMode === "full") {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Deny" }).click();
    await page.getByText(/Decision:\s*denied/i).waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "Trust once" }).click();
    await page.getByText(/Decision:\s*session/i).waitFor({ timeout: 60_000 });
    record("workspace.trust.deny-and-recover");
  }

  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator("textarea").last().waitFor({ timeout: 60_000 });
  record("host.restart.rehydrate");

  await page.screenshot({
    path: join(resultsDir, "desktop-e2e.png"),
    fullPage: true,
  });

  closeDesktopWindow();
  const desktopExitCode = await waitForDesktopExit();
  const cleanupResult = await cleanup(false);
  cleanupComplete = true;
  if (!cleanupResult.audit.clear) {
    throw new Error(
      `desktop cleanup audit failed: status=${cleanupResult.audit.status} output=${cleanupResult.audit.output}`,
    );
  }
  if (desktopExitCode !== 0) {
    throw new Error(`desktop exited with nonzero code ${desktopExitCode}`);
  }
  record("desktop.graceful-close", { desktopExitCode });
  writeResult({
    ok: true,
    status: "passed",
    profileIsolated: true,
    desktopExitCode,
    cleanupAudit: cleanupResult.audit,
    stderrTail: stderr,
  });
} catch (error) {
  const diagnostics = await collectFailureDiagnostics();
  fail(error instanceof Error ? error.message : String(error), { diagnostics });
} finally {
  if (!cleanupComplete) {
    await cleanup(true);
  }
}

process.exit(process.exitCode ?? 0);
