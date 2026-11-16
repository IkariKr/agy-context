/**
 * @fileoverview Context Window Unlocker & Preset Manager for Antigravity (agy-context)
 * Bridges agy-patch.py to detect, unlock, restore, and configure context window presets across macOS, Linux, and Windows.
 * @author q1u
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(__dirname, '..');
export const AGY_PATCH_PY = path.join(__dirname, 'agy-patch.py');

// Configuration directory for agy-context plugin settings
const USER_CONFIG_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-context');
const CONFIG_FILE = path.join(USER_CONFIG_DIR, 'context-settings.json');

// Supported presets and their nominal/effective token budget
export const PRESET_LIMITS = {
  'dynamic': null, // Follow dynamic detected limit
  '900k': 900000,  // 900K token budget
  '512k': 512000,  // 512K token budget
  '256k': 256000   // 256K nominal official clamp limit
};

let cachedPythonCmd = null;

/**
 * Resolves an active, working Python 3 executable across platforms.
 * Handles Windows Store app execution aliases, py launcher, and custom installation paths.
 * @returns {string} Executable command or absolute path
 */
export function resolvePython() {
  if (cachedPythonCmd) return cachedPythonCmd;

  const isWin = process.platform === 'win32';
  const candidates = [];

  if (isWin) {
    candidates.push(
      path.join(os.homedir(), '.local', 'bin', 'python3.12.exe'),
      path.join(os.homedir(), '.local', 'bin', 'python3.exe'),
      path.join(os.homedir(), '.local', 'bin', 'python.exe')
    );
    if (process.env.LOCALAPPDATA) {
      candidates.push(
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python313', 'python.exe'),
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe'),
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python311', 'python.exe'),
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python310', 'python.exe')
      );
    }
  }

  candidates.push('python3', 'python', 'py', 'python3.12');

  for (const cmd of candidates) {
    try {
      if (cmd.includes(path.sep) && !fs.existsSync(cmd)) continue;
      const res = cp.execSync(`"${cmd}" --version`, {
        timeout: 2500,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      if (res && (res.includes('Python 3') || res.includes('Python'))) {
        cachedPythonCmd = cmd;
        return cmd;
      }
    } catch (e) {}
  }

  cachedPythonCmd = isWin ? 'python' : 'python3';
  return cachedPythonCmd;
}

/**
 * Resolves candidate binary paths across macOS, Linux, and Windows.
 * @returns {{ desktop: string|null, cli: string|null }}
 */
export function resolveTargetBinaries() {
  const result = { desktop: null, cli: null };
  const isWin = process.platform === 'win32';

  // 1. Desktop Language Server Candidates
  const desktopCandidates = [
    // Windows
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Antigravity', 'resources', 'bin', 'language_server.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Antigravity', 'resources', 'bin', 'language_server.exe'),
    // macOS
    '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
    path.join(os.homedir(), 'Applications/Antigravity.app/Contents/Resources/bin/language_server'),
    // Linux
    '/usr/lib/antigravity/resources/bin/language_server',
    '/opt/antigravity/resources/bin/language_server',
    path.join(os.homedir(), '.local', 'share', 'antigravity', 'resources', 'bin', 'language_server')
  ];

  // Try finding from running processes first
  try {
    if (isWin) {
      const psCmd = 'Get-Process -Name language_server -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path | Select-Object -First 1';
      const psOut = cp.execSync(`powershell -NoProfile -Command "${psCmd}"`, {
        timeout: 3000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
      if (psOut && fs.existsSync(psOut)) {
        result.desktop = psOut;
      }
    } else {
      const ps = cp.execSync('ps aux | grep -E "language_server --standalone" | grep -v grep', {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'ignore']
      });
      const match = ps.match(/(\/[^\s]+language_server)/);
      if (match && fs.existsSync(match[1])) {
        result.desktop = match[1];
      }
    }
  } catch (e) {}

  if (!result.desktop) {
    for (const p of desktopCandidates) {
      if (fs.existsSync(p)) {
        result.desktop = p;
        break;
      }
    }
  }

  // 2. agy CLI Candidates
  const cliCandidates = [
    // Windows
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe'),
    path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agy.exe'),
    path.join(os.homedir(), '.local', 'bin', 'agy.exe'),
    // macOS / Linux
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agy'),
    '/usr/local/bin/agy'
  ];

  try {
    const whichCmd = isWin ? 'where.exe agy' : 'which agy';
    const whichAgy = cp.execSync(whichCmd, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    const firstLine = whichAgy.split(/\r?\n/)[0].trim();
    if (firstLine && fs.existsSync(firstLine)) {
      result.cli = firstLine;
    }
  } catch (e) {}

  if (!result.cli) {
    for (const p of cliCandidates) {
      if (fs.existsSync(p)) {
        result.cli = p;
        break;
      }
    }
  }

  return result;
}

/**
 * Executes agy-patch.py dry-run to determine whether a binary is unlocked
 * @param {string} binaryPath
 * @returns {Promise<{path: string, exists: boolean, isUnlocked: boolean, details: string, hasBackup: boolean}>}
 */
export async function inspectBinaryUnlock(binaryPath) {
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    return { path: binaryPath, exists: false, isUnlocked: false, details: 'Binary not found', hasBackup: false };
  }

  const baseName = path.basename(binaryPath);
  const backupDir = path.join(os.homedir(), 'Desktop', 'desktop-backups');
  const hasBak = fs.existsSync(`${binaryPath}.bak`) ||
    fs.existsSync(path.join(backupDir, `${baseName}.orig`)) ||
    fs.existsSync(path.join(backupDir, 'language_server.orig'));

  const py = resolvePython();
  const preset = getSavedPreset();
  const args = [AGY_PATCH_PY, '--binary', binaryPath, '--dry-run'];
  if (preset.targetLimit) {
    args.push('--limit', String(preset.targetLimit));
  } else if (preset.preset === 'dynamic') {
    args.push('--limit', '0');
  }

  return new Promise((resolve) => {
    cp.execFile(py, args, { timeout: 15000 }, (err, stdout, stderr) => {
      const output = `${stdout || ''}\n${stderr || ''}`;
      const isAlreadyUnlocked = output.includes('all gates already unlocked; nothing to write') ||
        (output.includes('[=]') && !output.includes('[*]'));
      
      resolve({
        path: binaryPath,
        exists: true,
        isUnlocked: isAlreadyUnlocked,
        details: output.trim(),
        hasBackup: hasBak
      });
    });
  });
}

/**
 * Gets overall unlock status for both Desktop and CLI
 * @returns {Promise<{desktop: any, cli: any, activePreset: string, currentLimit: number}>}
 */
export async function getOverallUnlockStatus() {
  const binaries = resolveTargetBinaries();
  const [desktopStatus, cliStatus] = await Promise.all([
    binaries.desktop ? inspectBinaryUnlock(binaries.desktop) : Promise.resolve(null),
    binaries.cli ? inspectBinaryUnlock(binaries.cli) : Promise.resolve(null)
  ]);

  const preset = getSavedPreset();
  return {
    desktop: desktopStatus,
    cli: cliStatus,
    activePreset: preset.preset,
    targetLimit: preset.targetLimit
  };
}

/**
 * Safely replaces a destination binary file, handling Windows process locking gracefully.
 * @param {string} srcFile Source file path
 * @param {string} dstFile Destination file path
 */
function safeReplaceBinary(srcFile, dstFile) {
  if (process.platform === 'win32') {
    try {
      fs.copyFileSync(srcFile, dstFile);
    } catch (err) {
      const oldFile = `${dstFile}.old.${process.pid}`;
      try {
        fs.renameSync(dstFile, oldFile);
        fs.copyFileSync(srcFile, dstFile);
      } catch (e2) {
        throw err;
      }
    }
  } else {
    fs.renameSync(srcFile, dstFile);
  }
}

/**
 * Unlocks the specified binary or all detected binaries
 * @param {'desktop'|'cli'|'all'} [target='all']
 * @returns {Promise<{success: boolean, message: string, output: string}>}
 */
export async function applyUnlock(target = 'all') {
  const binaries = resolveTargetBinaries();
  const targets = [];
  if ((target === 'desktop' || target === 'all') && binaries.desktop) {
    targets.push({ name: '桌面端 Language Server', path: binaries.desktop, isDesktop: true });
  }
  if ((target === 'cli' || target === 'all') && binaries.cli) {
    targets.push({ name: 'agy CLI 终端', path: binaries.cli, isDesktop: false });
  }

  if (targets.length === 0) {
    return { success: false, message: '未找到可解锁的目标二进制文件', output: '' };
  }

  const results = [];
  let allSuccess = true;
  const py = resolvePython();

  for (const item of targets) {
    // For desktop language_server, ensure external backup folder exists
    if (item.isDesktop) {
      try {
        const backupDir = path.join(os.homedir(), 'Desktop', 'desktop-backups');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        const baseName = path.basename(item.path);
        const origBackup = path.join(backupDir, `${baseName}.orig`);
        if (!fs.existsSync(origBackup)) {
          fs.copyFileSync(item.path, origBackup);
        }
      } catch (e) {}
    }

    const preset = getSavedPreset();
    const res = await new Promise((resolve) => {
      const args = [AGY_PATCH_PY, '--binary', item.path, '--in-place'];
      if (preset.targetLimit) {
        args.push('--limit', String(preset.targetLimit));
      } else if (preset.preset === 'dynamic') {
        args.push('--limit', '0');
      } else {
        args.push('--limit', '512000');
      }
      if (item.isDesktop) args.push('--no-backup'); // Keep app directory clean

      cp.execFile(py, args, { timeout: 30000 }, (err, stdout, stderr) => {
        const out = `${stdout || ''}\n${stderr || ''}`.trim();
        if (err && !out.includes('all gates already unlocked')) {
          resolve({ success: false, name: item.name, output: out, error: err.message });
        } else {
          resolve({ success: true, name: item.name, output: out });
        }
      });
    });

    results.push(res);
    if (!res.success) allSuccess = false;
  }

  const outputSummary = results.map(r => `[${r.name}] ${r.success ? '解锁成功' : '失败'}\n${r.output}`).join('\n\n');
  const restartHint = process.platform === 'darwin'
    ? '请完全退出并重启 Antigravity 应用（Cmd+Q）以加载新进程。'
    : '请完全退出并重启 Antigravity 应用（在任务栏/托盘退出后重新打开）以加载新进程。';

  return {
    success: allSuccess,
    message: allSuccess ? `目标上下文已成功解锁！已突破 256K 压缩硬上限。${restartHint}` : '解锁过程中遇到部分异常，请查看详情。',
    output: outputSummary
  };
}

/**
 * Restores original backup for the specified target using atomic replacement and proper code-signing
 * @param {'desktop'|'cli'|'all'} [target='all']
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function restoreOriginal(target = 'all') {
  const binaries = resolveTargetBinaries();
  const messages = [];
  let anySuccess = false;

  try {
    if ((target === 'desktop' || target === 'all') && binaries.desktop) {
      const backupDir = path.join(os.homedir(), 'Desktop', 'desktop-backups');
      const baseName = path.basename(binaries.desktop);
      const origCandidates = [
        path.join(backupDir, `${baseName}.orig`),
        path.join(backupDir, 'language_server.orig'),
        `${binaries.desktop}.bak`
      ];
      const source = origCandidates.find(p => fs.existsSync(p));

      if (source) {
        const tmpFile = `${binaries.desktop}.restore.tmp.${process.pid}`;
        fs.copyFileSync(source, tmpFile);
        if (process.platform !== 'win32') {
          fs.chmodSync(tmpFile, 0o755);
        }

        if (process.platform === 'darwin') {
          try {
            cp.execSync(`codesign --force --sign - --options runtime --identifier language_server "${tmpFile}"`);
          } catch (e) {
            try { cp.execSync(`codesign --force --sign - "${tmpFile}"`); } catch (e2) {}
          }
        }

        safeReplaceBinary(tmpFile, binaries.desktop);
        messages.push('已从备份恢复官方原版桌面端 language_server (需重启应用生效)');
        anySuccess = true;
      }
    }

    if ((target === 'cli' || target === 'all') && binaries.cli) {
      const bak = `${binaries.cli}.bak`;
      if (fs.existsSync(bak)) {
        const tmpFile = `${binaries.cli}.restore.tmp.${process.pid}`;
        fs.copyFileSync(bak, tmpFile);
        if (process.platform !== 'win32') {
          fs.chmodSync(tmpFile, 0o755);
        }
        if (process.platform === 'darwin') {
          try {
            cp.execSync(`codesign --force --sign - --options runtime --identifier cli "${tmpFile}"`);
          } catch (e) {}
        }
        safeReplaceBinary(tmpFile, binaries.cli);
        messages.push('已从备份恢复官方原版 agy CLI (需重启生效)');
        anySuccess = true;
      }
    }

    if (!anySuccess) {
      return { success: false, message: '未找到可供恢复的原始备份文件' };
    }

    return {
      success: true,
      message: messages.join('；') + '。'
    };
  } catch (err) {
    return { success: false, message: `恢复失败: ${err.message}` };
  }
}

/**
 * Reads user saved preset from local plugin data
 * @returns {{ preset: string, targetLimit: number|null }}
 */
export function getSavedPreset() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const preset = data.preset || 'dynamic';
      return {
        preset,
        targetLimit: PRESET_LIMITS[preset] ?? null
      };
    }
  } catch (e) {}

  return { preset: 'dynamic', targetLimit: null };
}

/**
 * Saves chosen preset to plugin data and synchronizes to CLI settings.json if exists
 * @param {string} preset ('dynamic' | '1m' | '900k' | '512k' | '256k')
 * @returns {{ preset: string, targetLimit: number|null, syncedCli: boolean }}
 */
export function savePreset(preset) {
  const validKey = PRESET_LIMITS.hasOwnProperty(preset) ? preset : 'dynamic';
  try {
    if (!fs.existsSync(USER_CONFIG_DIR)) {
      fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      preset: validKey,
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8');
  } catch (e) {}

  // Synchronize with ~/.gemini/antigravity-cli/settings.json if it exists
  let syncedCli = false;
  try {
    const cliSettingsPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
    if (fs.existsSync(cliSettingsPath)) {
      const settings = JSON.parse(fs.readFileSync(cliSettingsPath, 'utf8'));
      let cwVal = '';
      if (validKey === '900k') cwVal = '900K';
      else if (validKey === '512k') cwVal = '512K';
      else if (validKey === '256k') cwVal = '256K';
      else cwVal = ''; // default / 1m

      settings.contextWindow = cwVal;
      fs.writeFileSync(cliSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
      syncedCli = true;
    }
  } catch (e) {}

  return {
    preset: validKey,
    targetLimit: PRESET_LIMITS[validKey] ?? null,
    syncedCli
  };
}
