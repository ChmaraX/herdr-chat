// Windows: the process table and the clipboard through PowerShell, where macOS and Linux
// use ps, pgrep, lsof, osascript and wl-paste/xclip. Windows PowerShell 5.1
// (powershell.exe) ships with every Windows 10 and 11, so nothing is to install.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A process from Win32_Process: its command line is one string, as Windows keeps it. */
export type WinProc = { pid: number; ppid: number; name: string; path: string; cmdline: string; start: number | null };

const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

// One CIM query, as JSON lines (no ConvertTo-Json: its depth and single-item quirks). The
// filter is a number or nothing, never text from outside.
function query(pid: number | null): string {
  const filter = pid === null ? "" : ` -Filter "ProcessId=${Math.trunc(pid)}"`;
  return `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process${filter} | ForEach-Object { `
    + `[pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=[string]$_.Name; path=[string]$_.ExecutablePath; `
    + `cmdline=[string]$_.CommandLine; start=$(if ($_.CreationDate) { [int64](($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds) } else { $null }) } `
    + `| ConvertTo-Json -Compress }`;
}

function parse(out: string): WinProc[] {
  const procs: WinProc[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line);
      if (Number.isInteger(p.pid)) procs.push({ pid: p.pid, ppid: p.ppid ?? 0, name: p.name ?? "", path: p.path ?? "", cmdline: p.cmdline ?? "", start: typeof p.start === "number" ? p.start : null });
    } catch {}
  }
  return procs;
}

/** Every process (or the one `pid`), or throws when PowerShell couldn't say. */
export function winProcesses(pid: number | null = null): WinProc[] {
  return parse(execFileSync("powershell.exe", [...PS, query(pid)], { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }));
}

/** The same, without blocking. */
export function winProcessesAsync(pid: number | null = null): Promise<WinProc[]> {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", [...PS, query(pid)], { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(parse(stdout)));
  });
}

/**
 * A Windows command line split into its arguments, as the C runtime does
 * (CommandLineToArgvW): spaces outside quotes separate, `\"` is a quote,
 * backslashes are literal otherwise.
 */
export function splitCommandLine(s: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false, any = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\") {
      let n = 0;
      while (s[i] === "\\") (n++, i++);
      if (s[i] === '"') {
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2) cur += '"';
        else quoted = !quoted;
      } else {
        cur += "\\".repeat(n);
        i--;
      }
      any = true;
    } else if (c === '"') {
      quoted = !quoted;
      any = true;
    } else if ((c === " " || c === "\t") && !quoted) {
      if (any) out.push(cur);
      cur = "";
      any = false;
    } else {
      cur += c;
      any = true;
    }
  }
  if (any) out.push(cur);
  return out;
}

/** Saves the clipboard's image as a PNG at `path`: true, or false when it holds none. */
export function winClipboardImage(path: string): Promise<boolean> {
  // The path goes in the environment, not the script: no quoting to get wrong. -STA: the clipboard needs it.
  const script = "Add-Type -AssemblyName System.Windows.Forms, System.Drawing; "
    + "$i = [Windows.Forms.Clipboard]::GetImage(); "
    + "if ($i) { $i.Save($env:HERDR_CHAT_IMAGE, [Drawing.Imaging.ImageFormat]::Png); 'saved' }";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-STA", ...PS, script], { encoding: "utf8", timeout: 15_000, windowsHide: true, env: { ...process.env, HERDR_CHAT_IMAGE: path } }, (err, stdout) =>
      resolve(!err && stdout.includes("saved")));
  });
}

/** Shrinks the image `file` in place to `edge` px on its longest side (System.Drawing): whether it did. */
export function winShrinkImage(file: string, edge: number): Promise<boolean> {
  const script = "Add-Type -AssemblyName System.Drawing; "
    + "$src = [Drawing.Image]::FromFile($env:HERDR_CHAT_IMAGE); $fmt = $src.RawFormat; "
    + "$k = [Math]::Min(1.0, [double]$env:HERDR_CHAT_EDGE / [Math]::Max($src.Width, $src.Height)); "
    + "$w = [int][Math]::Max(1, [Math]::Round($src.Width * $k)); $h = [int][Math]::Max(1, [Math]::Round($src.Height * $k)); "
    + "$dst = New-Object Drawing.Bitmap $w, $h; $g = [Drawing.Graphics]::FromImage($dst); "
    + "$g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $g.DrawImage($src, 0, 0, $w, $h); "
    + "$g.Dispose(); $src.Dispose(); $dst.Save($env:HERDR_CHAT_IMAGE, $fmt); $dst.Dispose(); 'saved'";
  return new Promise((resolve) => {
    execFile("powershell.exe", [...PS, script], { encoding: "utf8", timeout: 30_000, windowsHide: true, env: { ...process.env, HERDR_CHAT_IMAGE: file, HERDR_CHAT_EDGE: String(edge) } }, (err, stdout) =>
      resolve(!err && stdout.includes("saved")));
  });
}

/**
 * A command as Windows can start it without a shell (Node refuses .cmd and .bat in spawn since
 * 20.12, and a script isn't a program): a bare name found on PATH as .exe, else .cmd; an npm
 * shim (.cmd) as node and the script it runs; a .js/.mjs/.cjs as node and the file. Anything
 * else as given. process.ts resolveCommand calls it on Windows only.
 */
export function winResolveCommand(command: string, args: string[]): { command: string; args: string[] } {
  let cmd = command;
  if (!/[\\/]/.test(cmd) && !/\.[a-z0-9]+$/i.test(cmd)) cmd = onPath(cmd) ?? cmd;
  if (/\.[mc]?js$/i.test(cmd)) return { command: process.execPath, args: [cmd, ...args] };
  if (/\.(cmd|bat)$/i.test(cmd)) {
    let text = "";
    try {
      text = readFileSync(cmd, "utf8");
    } catch {}
    const rel = npmShimTarget(text);
    const target = rel ? join(dirname(cmd), rel) : null;
    if (target && existsSync(target)) return /\.exe$/i.test(target) ? { command: target, args } : { command: process.execPath, args: [target, ...args] };
    // Node refuses it (EINVAL), and cmd.exe would re-read the arguments: say so instead.
    throw new Error(`${cmd} isn't a program: Windows runs .cmd and .bat files only through cmd.exe, and this one isn't an npm shim to read. Point the chat at the program (.exe) or its script (README "Configuration").`);
  }
  return { command: cmd, args };
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(";").filter(Boolean)) {
    for (const ext of [".exe", ".cmd", ".bat"]) {
      const f = join(dir, name + ext);
      if (existsSync(f)) return f;
    }
  }
  return null;
}

/**
 * The file an npm .cmd shim (npm's cmd-shim) runs, relative to the shim's folder, or null. Its last line is
 * `… "%_prog%"  "%dp0%\node_modules\…\cli.js" %*` (a script node runs) or `"%dp0%\node_modules\…\x.exe" %*`
 * (a native binary): the last `"%dp0%\…"`. An earlier one is the shim's `IF EXIST "%dp0%\node.exe"` (a node
 * beside it), no target.
 */
export function npmShimTarget(shim: string): string | null {
  const last = [...shim.matchAll(/"%dp0%\\([^"]+\.(?:[mc]?js|exe))"/gi)].at(-1)?.[1];
  return last && !/^node\.exe$/i.test(last) ? last : null;
}

/** Ends `pid` and every process under it (taskkill /T /F): Windows has no process groups to signal. */
export function winKillTree(pid: number): void {
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", timeout: 10_000, windowsHide: true });
  } catch {}
}
