#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadAlertConfig } from '../lib/alerts.mjs';
import { sendMail } from '../lib/mailer.mjs';

/**
 * Send one test email using <dsh home>/pulse-alert.json.
 *
 *   node tools/test-alert.mjs            # really send
 *   node tools/test-alert.mjs --dry-run  # print the resolved settings only
 */

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const { file, config, error } = loadAlertConfig(dshHome);

if (!config) {
  console.error(`Chưa có cấu hình: ${file}`);
  if (error) console.error(error);
  console.error('Tạo file theo mẫu trong README (mục "Cảnh báo số dư qua email").');
  process.exit(1);
}

const masked = { ...config, smtp: config.smtp ? { ...config.smtp, pass: config.smtp.pass ? '***' : undefined } : null };
console.log('config:', file);
console.log(JSON.stringify(masked, null, 2));

if (!config.to || !config.smtp?.host) {
  console.error('Thiếu "to" hoặc "smtp.host".');
  process.exit(1);
}

if (config.smtp?.user && !config.smtp?.pass) {
  console.error('Thiếu "smtp.pass" — với Gmail/Yahoo cần mật khẩu ứng dụng, không phải mật khẩu đăng nhập.');
  process.exit(1);
}

if (process.argv.includes('--dry-run')) process.exit(0);

const text = [
  'Đây là email thử từ DeepSeek Pulse.',
  '',
  `Ngưỡng cảnh báo: mỗi lần số dư giảm $${Number(config.dropAmount).toFixed(2)}.`,
  `Kiểm tra mỗi ${config.checkMinutes} phút.`,
  '',
  'DeepSeek Pulse',
].join('\n');

try {
  const result = await sendMail({
    smtp: config.smtp,
    from: config.from,
    to: config.to,
    subject: 'DeepSeek Pulse: email thử',
    text,
  });
  console.log('đã gửi:', result.response);
} catch (error) {
  console.error('gửi thất bại:', error.message);
  process.exit(1);
}
