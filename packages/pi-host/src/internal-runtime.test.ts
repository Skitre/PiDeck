import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUNDLED_BASH_ENV,
  BUNDLED_GIT_ENV,
  bundledBashFromGit,
  createInternalRuntime,
  resetInternalRuntimeForTests,
} from "./internal-runtime.js";

afterEach(() => {
  resetInternalRuntimeForTests();
});

function pathEntries(pathValue: string | undefined): string[] {
  return (pathValue ?? "").split(delimiter).filter(Boolean);
}

describe("createInternalRuntime", () => {
  it("keeps user env and internal env as distinct objects and does not mutate process.env", () => {
    const originalPath = process.env.PATH;
    const originalProxy = process.env.HTTP_PROXY;
    const source = {
      PATH: join("C:", "users", "mise", "shims"),
      Path: join("C:", "users", "fnm"),
      HTTP_PROXY: "http://proxy.example:8080",
      HTTPS_PROXY: "http://proxy.example:8080",
      SSL_CERT_FILE: "/tmp/cert.pem",
      HOME: "/home/user",
      APPDATA: "C:\\Users\\user\\AppData\\Roaming",
      USERPROFILE: "C:\\Users\\user",
      GIT_ASKPASS: "askpass",
      LANG: "en_US.UTF-8",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: "C:\\Windows",
      NODE_PATH: "/opt/node_modules",
      [BUNDLED_GIT_ENV]: "C:\\bundled\\git\\cmd\\git.exe",
      [BUNDLED_BASH_ENV]: "C:\\bundled\\git\\bin\\bash.exe",
      PIDECK_HOST_CACHE_DIR: "C:\\cache\\pi-host",
    };
    const nodeExecutable = join("C:", "bundled", "node", "node.exe");
    const gitExecutable = join("C:", "bundled", "git", "cmd", "git.exe");
    const bashExecutable = join("C:", "bundled", "git", "bin", "bash.exe");

    const runtime = createInternalRuntime({
      nodeExecutable,
      gitExecutable,
      bashExecutable,
      sourceEnv: source,
    });

    expect(runtime.env).not.toBe(source);
    expect(runtime.env).not.toBe(process.env);
    expect(runtime.nodeExecutable).toBe(nodeExecutable);
    expect(runtime.gitExecutable).toBe(gitExecutable);
    expect(runtime.bashExecutable).toBe(bashExecutable);
    expect(runtime.env.HTTP_PROXY).toBe("http://proxy.example:8080");
    expect(runtime.env.HTTPS_PROXY).toBe("http://proxy.example:8080");
    expect(runtime.env.SSL_CERT_FILE).toBe("/tmp/cert.pem");
    expect(runtime.env.HOME).toBe("/home/user");
    expect(runtime.env.APPDATA).toBe("C:\\Users\\user\\AppData\\Roaming");
    expect(runtime.env.GIT_ASKPASS).toBe("askpass");
    expect(runtime.env.LANG).toBe("en_US.UTF-8");
    expect(runtime.env.NODE_PATH).toBe("/opt/node_modules");
    expect(runtime.env.PIDECK_HOST_CACHE_DIR).toBe("C:\\cache\\pi-host");
    expect(runtime.env[BUNDLED_GIT_ENV]).toBeUndefined();
    expect(runtime.env[BUNDLED_BASH_ENV]).toBeUndefined();
    expect(runtime.env.Path).toBeUndefined();
    expect(pathEntries(runtime.env.PATH)[0]).toBe(dirname(nodeExecutable));
    expect(pathEntries(runtime.env.PATH)).toContain(dirname(gitExecutable));
    expect(pathEntries(runtime.env.PATH)).toContain(join("C:", "bundled", "git", "bin"));
    expect(pathEntries(runtime.env.PATH)).toContain(join("C:", "bundled", "git", "mingw64", "bin"));
    expect(runtime.env.PATH).not.toContain("mise");
    expect(runtime.env.PATH).not.toContain("fnm");
    expect(process.env.PATH).toBe(originalPath);
    expect(process.env.HTTP_PROXY).toBe(originalProxy);
  });

  it("does not append the user PATH and filters private bundled-git metadata", () => {
    const userMarker = join("C:", "user-tools", "pideck-user-marker");
    const runtime = createInternalRuntime({
      nodeExecutable: join("D:", "runtime", "node.exe"),
      gitExecutable: join("D:", "runtime", "git", "cmd", "git.exe"),
      sourceEnv: {
        PATH: userMarker,
        [BUNDLED_GIT_ENV]: join("D:", "runtime", "git", "cmd", "git.exe"),
        [BUNDLED_BASH_ENV]: join("D:", "runtime", "git", "bin", "bash.exe"),
      },
    });
    expect(runtime.env.PATH).not.toContain("pideck-user-marker");
    expect(runtime.env[BUNDLED_GIT_ENV]).toBeUndefined();
    expect(runtime.env[BUNDLED_BASH_ENV]).toBeUndefined();
    expect(runtime.bashExecutable).toBe(join("D:", "runtime", "git", "bin", "bash.exe"));
    expect(bundledBashFromGit(join("D:", "runtime", "git", "cmd", "git.exe"))).toBe(
      join("D:", "runtime", "git", "bin", "bash.exe"),
    );
  });

  it("falls back to source PATH git when bundled git is absent", () => {
    const gitDir = dirname(process.execPath);
    const gitName = process.platform === "win32" ? "git.exe" : "git";
    const runtime = createInternalRuntime({
      nodeExecutable: process.execPath,
      sourceEnv: {
        ...process.env,
        PATH: gitDir,
        [BUNDLED_GIT_ENV]: undefined,
      },
    });
    if (runtime.gitExecutable) {
      expect(runtime.gitExecutable.endsWith(gitName) || runtime.gitExecutable.includes("git")).toBe(
        true,
      );
    }
    expect(runtime.env.PATH).toContain(dirname(process.execPath));
  });
});
