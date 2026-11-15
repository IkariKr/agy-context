/**
 * @fileoverview Context Window Unlocker & Preset Manager for Antigravity (agy-context)
 * Bridges agy-patch.py to detect, unlock, restore, and configure context window presets.
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

/**
 * Resolves candidate binary paths across macOS and Linux/Windows
 * @returns {{ desktop: string|null, cli: string|null }}
 */
export function resolveTargetBinaries() {
  const result = { desktop: null, cli: null };

  // 1. Desktop Language Server
  const desktopCandidates = [
    '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
    path.join(os.homedir(), 'Applications/Antigravity.app/Contents/Resources/bin/language_server')
  ];

  // Try finding from running processes first
  try {
    const ps = cp.execSync('ps aux | grep -E "language_server --standalone" | grep -v grep', { encoding: 'utf8' });
    const match = ps.match(/(\/[^\s]+language_server)/);
    if (match && fs.existsSync(match[1])) {
      result.desktop = match[1];
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

  // 2. agy CLI
  const cliCandidates = [
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agy'),
    '/usr/local/bin/agy'
  ];

  try {
    const whichAgy = cp.execSync('which agy', { encoding: 'utf8' }).trim();
    if (whichAgy && fs.existsSync(whichAgy)) {
      result.cli = whichAgy;
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

  const hasBak = fs.existsSync(`${binaryPath}.bak`) ||
    fs.existsSync(path.join(os.homedir(), 'Desktop', 'desktop-backups', 'language_server.orig'));

  return new Promise((resolve) => {
    cp.execFile('python3', [AGY_PATCH_PY, '--binary', binaryPath, '--dry-run'], { timeout: 15000 }, (err, stdout, stderr) => {
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

  for (const item of targets) {
    // For desktop language_server, ensure external backup folder exists if needed
    if (item.isDesktop) {
      try {
        const backupDir = path.join(os.homedir(), 'Desktop', 'desktop-backups');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        const origBackup = path.join(backupDir, 'language_server.orig');
        if (!fs.existsSync(origBackup)) {
          fs.copyFileSync(item.path, origBackup);
        }
      } catch (e) {}
    }

    const res = await new Promise((resolve) => {
      const args = [AGY_PATCH_PY, '--binary', item.path, '--in-place'];
      if (item.isDesktop) args.push('--no-backup'); // Avoid placing .bak inside .app bundle

      cp.execFile('python3', args, { timeout: 30000 }, (err, stdout, stderr) => {
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
  return {
    success: allSuccess,
    message: allSuccess ? '目标上下文已成功解锁！已突破 256K 压缩硬上限。请退出并重启 Antigravity 应用（Cmd+Q）以加载新进程。' : '解锁过程中遇到部分异常，请查看详情。',
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
      const origBackup = path.join(os.homedir(), 'Desktop', 'desktop-backups', 'language_server.orig');
      const bakFile = `${binaries.desktop}.bak`;
      const source = fs.existsSync(origBackup) ? origBackup : (fs.existsSync(bakFile) ? bakFile : null);
      if (source) {
        const tmpFile = `${binaries.desktop}.restore.tmp.${process.pid}`;
        fs.copyFileSync(source, tmpFile);
        fs.chmodSync(tmpFile, 0o755);

        try {
          cp.execSync(`codesign --force --sign - --options runtime --identifier language_server "${tmpFile}"`);
        } catch (e) {
          try { cp.execSync(`codesign --force --sign - "${tmpFile}"`); } catch (e2) {}
        }

        fs.renameSync(tmpFile, binaries.desktop);
        messages.push('已从备份恢复官方原版桌面端 language_server (需 Cmd+Q 重启)');
        anySuccess = true;
      }
    }

    if ((target === 'cli' || target === 'all') && binaries.cli) {
      const bak = `${binaries.cli}.bak`;
      if (fs.existsSync(bak)) {
        const tmpFile = `${binaries.cli}.restore.tmp.${process.pid}`;
        fs.copyFileSync(bak, tmpFile);
        fs.chmodSync(tmpFile, 0o755);
        try {
          cp.execSync(`codesign --force --sign - --options runtime --identifier cli "${tmpFile}"`);
        } catch (e) {}
        fs.renameSync(tmpFile, binaries.cli);
        messages.push('已从备份恢复官方原版 agy CLI');
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
