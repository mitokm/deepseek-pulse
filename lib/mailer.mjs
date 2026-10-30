import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

/**
 * Minimal SMTP client (no dependencies) used by the balance alert.
 *
 * Supports implicit TLS (port 465), STARTTLS (port 587) and AUTH PLAIN/LOGIN —
 * enough for Gmail/Outlook app passwords and most self-hosted relays.
 */

const CRLF = '\r\n';

function base64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function wrap76(text) {
  const lines = [];
  for (let i = 0; i < text.length; i += 76) lines.push(text.slice(i, i + 76));
  return lines.join(CRLF);
}

class Reader {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.lines = [];
    this.queue = [];
    this.waiters = [];
    this.error = null;

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.push(chunk));
    socket.on('error', (error) => {
      this.error = error;
      this.fail(error);
    });
    socket.on('close', () => this.fail(new Error('SMTP connection closed')));
  }

  push(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      this.lines.push(this.buffer.slice(0, index).replace(/\r$/, ''));
      this.buffer = this.buffer.slice(index + 1);
    }
    this.drain();
  }

  drain() {
    // A reply ends on a line whose 4th character is a space ("250 ").
    const end = this.lines.findIndex((line) => /^\d{3} /.test(line) || /^\d{3}$/.test(line));
    if (end === -1) return;
    const reply = this.lines.slice(0, end + 1).join('\n');
    this.lines = this.lines.slice(end + 1);
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(reply);
    else this.queue.push(reply);
  }

  fail(error) {
    while (this.waiters.length) this.waiters.shift().reject(error);
  }

  next() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SMTP timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
      this.waiters.push({
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }
}

function upgrade(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({ socket, servername: host });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new Error('SMTP STARTTLS timeout'));
    }, timeoutMs);
    secure.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(secure);
    });
    secure.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function sendMail({ smtp, from, to, subject, text, timeoutMs = 20000 }) {
  if (!smtp?.host) throw new Error('SMTP host is required');
  if (!from || !to) throw new Error('Both "from" and "to" are required');

  const host = smtp.host;
  const port = Number(smtp.port) || (smtp.secure ? 465 : 587);
  let socket = smtp.secure === false
    ? netConnect({ host, port })
    : tlsConnect({ host, port, servername: host });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SMTP connect timeout')), timeoutMs);
    const ready = smtp.secure === false ? 'connect' : 'secureConnect';
    socket.once(ready, () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });

  let reader = new Reader(socket, timeoutMs);

  const command = async (line, expected) => {
    socket.write(line + CRLF);
    const reply = await reader.next();
    const code = Number(reply.slice(0, 3));
    if (!expected.includes(code)) {
      throw new Error(`SMTP rejected ${line.split(' ')[0]}: ${reply.split('\n')[0]}`);
    }
    return reply;
  };

  const greeting = await reader.next();
  if (Number(greeting.slice(0, 3)) !== 220) throw new Error(`SMTP greeting failed: ${greeting.split('\n')[0]}`);

  let capabilities = await command(`EHLO ${smtp.clientName ?? 'localhost'}`, [250]);

  if (smtp.secure === false && /STARTTLS/i.test(capabilities)) {
    await command('STARTTLS', [220]);
    socket = await upgrade(socket, host, timeoutMs);
    reader = new Reader(socket, timeoutMs);
    capabilities = await command(`EHLO ${smtp.clientName ?? 'localhost'}`, [250]);
  }

  if (smtp.user) {
    const mechanisms = capabilities
      .split('\n')
      .filter((line) => /AUTH/i.test(line))
      .join(' ');
    if (smtp.authMethod === 'LOGIN' || (!/PLAIN/i.test(mechanisms) && /LOGIN/i.test(mechanisms))) {
      await command('AUTH LOGIN', [334]);
      await command(base64(smtp.user), [334]);
      await command(base64(smtp.pass ?? ''), [235]);
    } else {
      await command(`AUTH PLAIN ${base64(`\0${smtp.user}\0${smtp.pass ?? ''}`)}`, [235]);
    }
  }

  await command(`MAIL FROM:<${smtp.from ?? from}>`, [250]);
  await command(`RCPT TO:<${to}>`, [250, 251]);
  await command('DATA', [354]);

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${base64(subject)}?=`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@pulse.local>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ].join(CRLF);

  socket.write(`${headers}${CRLF}${CRLF}${wrap76(base64(text))}${CRLF}.${CRLF}`);
  const accepted = await reader.next();
  if (Number(accepted.slice(0, 3)) !== 250) throw new Error(`SMTP DATA rejected: ${accepted.split('\n')[0]}`);

  try {
    socket.write(`QUIT${CRLF}`);
  } catch {
    // The server may already have closed the socket; the mail was accepted.
  }
  socket.end();
  return { accepted: true, response: accepted.split('\n')[0] };
}
