'use strict';
/**
 * drive-backup.js — weekly HouseFund backup to Google Drive.
 *
 * Pulls /api/backup from the live app (token-gated), uploads the dump to
 * the "HouseFund Backups" Drive folder, keeps the newest 12, trashes older.
 *
 * Env: HF_APP_URL (e.g. https://housefund.onrender.com), HF_BACKUP_TOKEN
 * Run: node drive-backup.js   (intended for a weekly cron)
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLI = '/opt/hatch/bin/hatch_gws_cli';
const FOLDER = 'HouseFund Backups';
const KEEP = 12;

function sh(...args) {
  return execFileSync(CLI, args, { encoding: 'utf8' });
}
function drive(method, params, extra = []) {
  const out = sh('drive', 'files', method, '--params', JSON.stringify(params), ...extra);
  return out.trim() ? JSON.parse(out) : {};
}

async function main() {
  const appUrl = (process.env.HF_APP_URL || '').replace(/\/$/, '');
  const token = process.env.HF_BACKUP_TOKEN;
  if (!appUrl || !token) throw new Error('Set HF_APP_URL and HF_BACKUP_TOKEN first.');

  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(__dirname, 'data', 'drive-staging');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `housefund-backup-${day}.json`);

  console.log('[backup] pulling from', appUrl);
  execFileSync('curl', ['-sf', `${appUrl}/api/backup?token=${encodeURIComponent(token)}`, '-o', file]);
  const bytes = fs.statSync(file).size;
  if (bytes < 100) throw new Error('Backup looks empty (' + bytes + ' bytes) — aborting upload.');
  console.log('[backup] pulled', bytes, 'bytes');

  // Ensure the folder exists.
  let res = drive('list', {
    q: `name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    pageSize: 1, fields: 'files(id,name)',
  });
  let folderId = res.files && res.files[0] && res.files[0].id;
  if (!folderId) {
    const created = JSON.parse(sh('drive', 'files', 'create',
      '--params', JSON.stringify({ ignoreDefaultVisibility: true }),
      '--json', JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' })));
    folderId = created.id;
    console.log('[backup] created folder', FOLDER, folderId);
  }

  // Upload the new backup.
  console.log('[backup] uploading to Drive…');
  sh('drive', '+upload', file, '--parent', folderId, '--name', path.basename(file));
  console.log('[backup] uploaded', path.basename(file));

  // Rotate: keep newest KEEP, trash the rest.
  res = drive('list', {
    q: `'${folderId}' in parents and trashed=false`,
    orderBy: 'createdTime desc', pageSize: 50, fields: 'files(id,name,createdTime)',
  });
  const olds = (res.files || []).slice(KEEP);
  for (const f of olds) {
    sh('drive', 'files', 'update', '--params', JSON.stringify({ fileId: f.id }), '--json', JSON.stringify({ trashed: true }));
    console.log('[backup] trashed old copy', f.name);
  }
  console.log('[backup] done.');
}

main().catch((e) => { console.error('[backup] FAILED:', e.message); process.exit(1); });
