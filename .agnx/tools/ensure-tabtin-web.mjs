#!/usr/bin/env node
/**
 * 场景：短跑 sidecar — 确保 TabTin（Django 后端 + tabtin-web 前端）已在 127.0.0.1:<port> 上。
 *       端口已健康则复用；--force-restart 则停旧再起。
 * 用法：node .agnx/tools/ensure-tabtin-web.mjs [--port <n>] [--work-dir <dataRoot>] [--force-restart] [--supervised]
 * stdout：最后一行单行 JSON { ok, port, origin, reused, pid, backend?, warnings? }；失败 { ok:false, error } 且 exitCode=1
 *
 * 上游启动方式（不改造上游，只传端口/环境变量）：
 *   backend : apps/tabtin_django → <venv>/python -m daphne -b 127.0.0.1 -p 6060 tabtin.asgi:application
 *   frontend: apps/tabtin-web    → vite --port <port> --host 127.0.0.1（/api 反代到 6060）
 *
 * 端口纪律：上游默认 Centrifugo=8100，本项目 8100 已被 openhands 占用，故全部错开到 8107 对外。
 */
import { spawn } from "node:child_process";
import { readFileSync, openSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** clone 根 = TabTin 仓根 */
const repoRoot = path.resolve(__dirname, "../..");
const defaultPort = 8107;
const backendPort = 6060;

function trace(phase, fields) {
  process.stderr.write(`[ensure-tabtin-web] ${JSON.stringify({ phase, ...fields })}\n`);
}

function parseArgs(argv) {
  let workDir = process.env.AGNX_APP_DATA_ROOT || "";
  let port = defaultPort;
  let forceRestart = false;
  let supervised = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === "--work-dir" || arg === "--workDir") && next) {
      workDir = String(next).trim();
      i += 1;
    } else if (arg === "--port" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) {
        port = n;
      }
      i += 1;
    } else if (arg === "--force-restart" || arg === "--forceRestart") {
      forceRestart = true;
    } else if (arg === "--supervised") {
      supervised = true;
    }
  }
  return {
    workDir: workDir || path.join(repoRoot, ".agnx-runtime"),
    port,
    forceRestart,
    supervised,
  };
}

async function pathExists(p) {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function httpStatus(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", () => resolve(0));
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
  });
}

/** 端口有监听（不管是哪个服务）即视为活着，避免 UI 未全亮时误判。 */
function tcpListening(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (v) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) {
    return false;
  }
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function stopPid(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) {
    return;
  }
  try {
    process.kill(n, "SIGTERM");
  } catch {
    /* ignore */
  }
}

async function readJson(p) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function waitFor(predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function spawnDetached(command, args, { cwd, env, logPath }) {
  // 注意：不要用 pipe —— 子进程会继承管道句柄，导致本 ensure 进程即使 unref 也无法退出
  // （`ensure | tail` 会挂住）。统一重定向到日志文件，失败时再读尾部。
  const fd = openSync(logPath, "a");
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  return { child, logPath };
}

function readLogTail(logPath, maxBytes = 4000) {
  try {
    const buf = readFileSync(logPath);
    return buf.subarray(Math.max(0, buf.length - maxBytes)).toString("utf8").trim();
  } catch {
    return "";
  }
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const warnings = [];
  await mkdir(cfg.workDir, { recursive: true });
  const statePath = path.join(cfg.workDir, "tabtin-web.json");

  const webRoot = path.join(repoRoot, "apps", "tabtin-web");
  const djangoRoot = path.join(repoRoot, "apps", "tabtin_django");
  const venvPython = path.join(djangoRoot, ".venv", "bin", "python");

  if (!(await pathExists(path.join(webRoot, "package.json")))) {
    console.log(JSON.stringify({ ok: false, error: `未找到 tabtin-web：${webRoot}` }));
    process.exitCode = 1;
    return;
  }
  if (!(await pathExists(venvPython))) {
    console.log(
      JSON.stringify({
        ok: false,
        error: `未找到 TabTin 后端虚拟环境：${venvPython}。请先执行 uv venv --python 3.11 && uv pip install -r requirements.txt`,
      }),
    );
    process.exitCode = 1;
    return;
  }

  const existing = await readJson(statePath);
  const frontAlive = await tcpListening("127.0.0.1", cfg.port);
  const backAlive = await httpStatus(`http://127.0.0.1:${backendPort}/health`) === 200;

  if (!cfg.forceRestart && frontAlive && backAlive) {
    trace("reuse", { port: cfg.port, backendPort });
    console.log(
      JSON.stringify({
        ok: true,
        reused: true,
        port: cfg.port,
        pid: existing?.pid ?? null,
        origin: `http://127.0.0.1:${cfg.port}`,
        backend: `http://127.0.0.1:${backendPort}`,
        warnings,
      }),
    );
    return;
  }

  // 收拾旧实例
  if (existing && isPidAlive(existing.pid)) {
    stopPid(existing.pid);
  }
  if (existing && isPidAlive(existing.backendPid)) {
    stopPid(existing.backendPid);
  }
  if (cfg.forceRestart) {
    await new Promise((r) => setTimeout(r, 800));
  }

  // 1) Django 后端
  let backendPid = existing?.backendPid ?? null;
  if (!backAlive) {
    trace("spawn.backend", { port: backendPort });
    const backend = spawnDetached(
      venvPython,
      ["-m", "daphne", "-b", "127.0.0.1", "-p", String(backendPort), "tabtin.asgi:application"],
      {
        cwd: djangoRoot,
        env: { ...process.env, DEBUG: process.env.DEBUG ?? "true" },
        logPath: path.join(cfg.workDir, "tabtin-django.log"),
      },
    );
    backendPid = backend.child.pid ?? null;
    const ready = await waitFor(async () => (await httpStatus(`http://127.0.0.1:${backendPort}/health`)) === 200, 120_000);
    if (!ready) {
      stopPid(backendPid);
      const out = readLogTail(backend.logPath);
      console.log(
        JSON.stringify({
          ok: false,
          error: out ? `TabTin 后端启动超时：${out.slice(-400)}` : "TabTin 后端启动超时（daphne 未在 120s 内就绪）",
        }),
      );
      process.exitCode = 1;
      return;
    }
  }

  // 2) 前端 Vite
  let frontPid = existing?.pid ?? null;
  if (!frontAlive) {
    trace("spawn.frontend", { port: cfg.port });
    const viteBin = path.join(webRoot, "node_modules", ".bin", "vite");
    const front = spawnDetached(viteBin, ["--port", String(cfg.port), "--host", "127.0.0.1"], {
      cwd: webRoot,
      env: {
        ...process.env,
        // 上游 vite.config.ts 的 requireApiBaseUrl 强校验，缺了直接拒绝启动。
        // 这里注入的是「启动参数」而非改上游源码。
        TABTIN_API_BASE_URL: process.env.TABTIN_API_BASE_URL || `http://127.0.0.1:${backendPort}/api`,
        VITE_API_BASE_URL: process.env.VITE_API_BASE_URL || `http://127.0.0.1:${backendPort}/api`,
        TABTIN_PUBLIC_WEB_BASE_URL:
          process.env.TABTIN_PUBLIC_WEB_BASE_URL || `http://127.0.0.1:${cfg.port}`,
        VITE_PUBLIC_WEB_BASE_URL:
          process.env.VITE_PUBLIC_WEB_BASE_URL || `http://127.0.0.1:${cfg.port}`,
        VITE_DEV_SERVER_PORT: String(cfg.port),
        DEVSERVER_PORT: String(cfg.port),
      },
      logPath: path.join(cfg.workDir, "tabtin-vite.log"),
    });
    frontPid = front.child.pid ?? null;
    const ready = await waitFor(async () => (await tcpListening("127.0.0.1", cfg.port)), 120_000);
    if (!ready) {
      stopPid(frontPid);
      const out = readLogTail(front.logPath);
      console.log(
        JSON.stringify({
          ok: false,
          error: out ? `TabTin 前端启动超时：${out.slice(-400)}` : "TabTin 前端启动超时（Vite 未就绪）",
        }),
      );
      process.exitCode = 1;
      return;
    }
  }

  await writeFile(
    statePath,
    JSON.stringify({ port: cfg.port, pid: frontPid, backendPid, updatedAt: Date.now() }, null, 2),
    "utf8",
  );

  console.log(
    JSON.stringify({
      ok: true,
      reused: false,
      port: cfg.port,
      pid: frontPid,
      origin: `http://127.0.0.1:${cfg.port}`,
      backend: `http://127.0.0.1:${backendPort}`,
      warnings,
    }),
  );
}

main().catch((error) => {
  console.log(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  process.exitCode = 1;
});
