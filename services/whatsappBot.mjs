import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

const require = createRequire(import.meta.url);
const { logger } = require('../config/logger.js');
const { getSetting } = require('../config/settingsManager.js');
const customerDevice = require('./customerDeviceService.js');
const { WaLidStore } = require('./waLidStore.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

function getMessageText(m) {
  const msg = m.message;
  if (!msg) return '';
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  return '';
}

/** Field tambahan Baileys 6.7: senderPn = JID nomor, senderLid = JID @lid */
function normalizeKey(key) {
  if (!key) return {};
  return {
    remoteJid: key.remoteJid,
    senderPn: key.senderPn || null,
    senderLid: key.senderLid || null
  };
}

async function resolveCustomerTag(key, lidStore) {
  const { remoteJid, senderPn, senderLid } = normalizeKey(key);
  if (!remoteJid || remoteJid.endsWith('@g.us')) return null;

  const tryPnAndCache = async (pnJid, lidJid) => {
    const digits = customerDevice.phoneFromPnJid(pnJid);
    if (!digits) return null;
    const found = await customerDevice.findDeviceWithTagVariants(digits);
    if (!found) return null;
    if (lidJid) lidStore.set(lidJid, found.canonicalTag);
    lidStore.set(pnJid, found.canonicalTag);
    return found.canonicalTag;
  };

  if (remoteJid.endsWith('@s.whatsapp.net')) {
    const found = await tryPnAndCache(remoteJid, senderLid && senderLid.endsWith('@lid') ? senderLid : null);
    if (found) return found;
    return lidStore.get(remoteJid);
  }

  if (remoteJid.endsWith('@lid')) {
    const cached = lidStore.get(remoteJid);
    if (cached) return cached;
    if (senderPn && senderPn.endsWith('@s.whatsapp.net')) {
      return tryPnAndCache(senderPn, remoteJid);
    }
    return null;
  }

  return null;
}

function formatInfo(data) {
  if (!data) return '❌ Data perangkat tidak ditemukan di GenieACS.';
  
  const companyHeader = getSetting('company_header', 'ALIJAYA WEBPORTAL');
  const footerInfo = getSetting('footer_info', 'Internet Tanpa Batas');
  
  const header = `📱 *INFO PERANGKAT ONU*\n${'─'.repeat(30)}\n📊 *${companyHeader}*\n${'─'.repeat(30)}\n`;
  const footer = `\n${'─'.repeat(30)}\n${footerInfo}`;
  
  const lines = [
    `🟢 *Status:* ${data.status}`,
    `📶 *SSID:* ${data.ssid}`,
    `⏱️ *Last Inform:* ${data.lastInform}`,
    `📡 *RX Power:* ${data.rxPower}`,
    `🌐 *PPPoE IP:* ${data.pppoeIP}`,
    `👤 *PPPoE User:* ${data.pppoeUsername}`,
    `⏳ *Uptime:* ${data.uptime}`,
    `📱 *User WiFi (2.4G):* ${data.totalAssociations}`,
    `🔧 *Model:* ${data.model}`,
    `🏷️ *Serial Number:* ${data.serialNumber}`,
    `💾 *Firmware:* ${data.softwareVersion}`,
    `📍 *Tag:* ${data.lokasi}`
  ];
  
  return header + lines.join('\n') + footer;
}

function formatCekTerhubung(data) {
  if (!data) return '❌ Data tidak tersedia.';
  const list = data.connectedUsers || [];
  
  const companyHeader = getSetting('company_header', 'ALIJAYA WEBPORTAL');
  const footerInfo = getSetting('footer_info', 'Internet Tanpa Batas');
  
  const header = `📱 *PERANGKAT TERHUBUNG*\n${'─'.repeat(30)}\n📊 *${companyHeader}*\n${'─'.repeat(30)}\n`;
  const footer = `\n${'─'.repeat(30)}\n${footerInfo}`;
  
  if (list.length === 0) {
    return header + `\n❌ Tidak ada entri host/perangkat terhubung di data ONU.` + footer;
  }
  
  const content = `📊 *${list.length} perangkat tercatat:*\n`;
  const rows = list.slice(0, 25).map((u, i) => {
    const num = String(i + 1).padStart(2, '0');
    return `${num}. 📱 ${u.hostname}\n   🌐 ${u.ip} | ${u.status}`;
  }).join('\n\n');
  const tail = list.length > 25 ? `\n\n_…dan ${list.length - 25} perangkat lainnya_` : '';
  
  return header + content + rows + tail + footer;
}

function loadWhatsappAdminSet() {
  const raw = getSetting('whatsapp_admin_numbers', []);
  const list = Array.isArray(raw) ? raw : raw != null && String(raw).trim() !== '' ? [String(raw)] : [];
  const set = new Set();
  for (const n of list) {
    const s = String(n).trim();
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 8) {
      for (const c of customerDevice.expandTagCandidates(digits)) {
        set.add(c);
      }
    } else if (s) {
      set.add(s);
    }
  }
  return set;
}

/** Admin dikenali dari nomor WA (bukan @lid saja). Pakai senderPn atau remoteJid @s.whatsapp.net */
function isWhatsappAdminKey(key, adminSet) {
  if (!adminSet || adminSet.size === 0) return false;
  const nk = normalizeKey(key);
  const pnJid =
    nk.senderPn && nk.senderPn.endsWith('@s.whatsapp.net')
      ? nk.senderPn
      : nk.remoteJid && nk.remoteJid.endsWith('@s.whatsapp.net')
        ? nk.remoteJid
        : null;
  if (!pnJid) return false;
  const digits = customerDevice.phoneFromPnJid(pnJid);
  if (!digits) return false;
  for (const c of customerDevice.expandTagCandidates(digits)) {
    if (adminSet.has(c)) return true;
  }
  return false;
}

function parseCommand(text, isAdmin) {
  const t = String(text || '').trim();
  if (!t) return null;
  const parts = t.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const rest = t.slice(parts[0].length).trim();

  if (['menu', 'bantuan', 'help'].includes(cmd)) return { cmd: 'menu', rest: '' };

  if (isAdmin && ['adminmenu', 'menuadmin'].includes(cmd)) return { cmd: 'adminmenu', rest: '' };

  if (isAdmin && ['listonu', 'listdevice', 'daftarperangkat'].includes(cmd)) {
    return { cmd: 'listonu', admin: true };
  }

  if (isAdmin && cmd === 'info' && parts.length >= 2) {
    return { cmd: 'info', admin: true, targetTag: parts[1], rest: '' };
  }
  if (isAdmin && cmd === 'cekterhubung' && parts.length >= 2) {
    return { cmd: 'cekterhubung', admin: true, targetTag: parts[1] };
  }
  if (isAdmin && (cmd === 'reboot' || cmd === 'restartonu') && parts.length >= 2) {
    return { cmd: 'reboot', admin: true, targetTag: parts[1] };
  }
  if (isAdmin && cmd === 'gantissid' && parts.length >= 3) {
    return { cmd: 'gantissid', admin: true, targetTag: parts[1], rest: parts.slice(2).join(' ') };
  }
  if (isAdmin && cmd === 'gantisandi' && parts.length >= 3) {
    return { cmd: 'gantisandi', admin: true, targetTag: parts[1], rest: parts.slice(2).join(' ') };
  }

  if (cmd === 'info') return { cmd: 'info', rest: '' };
  if (cmd === 'cekterhubung') return { cmd: 'cekterhubung', rest: '' };
  if (cmd === 'gantissid') return { cmd: 'gantissid', rest };
  if (cmd === 'gantisandi') return { cmd: 'gantisandi', rest };
  if (cmd === 'daftar') return { cmd: 'daftar', rest };
  if (cmd === 'reboot' || cmd === 'restartonu') return { cmd: 'reboot', rest: '' };
  return null;
}

async function resolveTargetTagForAdmin(tagToken) {
  if (!tagToken) return null;
  const found = await customerDevice.findDeviceWithTagVariants(tagToken);
  return found ? found.canonicalTag : null;
}

function formatListOnu(devices) {
  const companyHeader = getSetting('company_header', 'ALIJAYA WEBPORTAL');
  const footerInfo = getSetting('footer_info', 'Internet Tanpa Batas');
  
  const header = `📱 *DAFTAR ONU BER-TAG*
${'─'.repeat(30)}
📊 *${companyHeader}*
${'─'.repeat(30)}
`;
  const footer = `
${'─'.repeat(30)}
${footerInfo}`;
  
  if (!devices || devices.length === 0) {
    return header + `❌ Tidak ada perangkat dengan tag.` + footer;
  }
  
  const content = `📊 *${devices.length} perangkat ditemukan:*
`;
  const lines = devices.map((d, i) => {
    const num = String(i + 1).padStart(2, '0');
    const tags = Array.isArray(d._tags) ? d._tags.join(', ') : String(d._tags || '-');
    const pppoeUsername = d.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.Username?._value || '-';
    const li = d._lastInform ? new Date(d._lastInform).toLocaleString('id-ID') : '-';
    return `${num}. 🏷️ *${tags}*
   � PPPoE: ${pppoeUsername}
   ⏱️ Last inform: ${li}`;
  }).join('\n\n');
  
  return header + content + lines + footer;
}

function splitWaChunks(text, maxLen = 3500) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= maxLen) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf('\n\n', maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return chunks;
}

/** Kirim notifikasi ke pelanggan saat admin mengubah SSID/Password */
async function notifyCustomer(sock, lidStore, tag, message) {
  try {
    // Cari JID pelanggan berdasarkan tag
    const customerJid = lidStore.getByTag(tag);
    if (customerJid) {
      await sock.sendMessage(customerJid, { text: message });
      return true;
    }
    // Jika tidak ditemukan di lidStore, coba kirim ke nomor tag langsung
    const phoneNumber = tag.replace(/\D/g, '');
    if (phoneNumber.length >= 10) {
      const directJid = `${phoneNumber}@s.whatsapp.net`;
      await sock.sendMessage(directJid, { text: message });
      return true;
    }
    return false;
  } catch (e) {
    logger.error('Gagal mengirim notifikasi ke pelanggan:', e.message || e);
    return false;
  }
}

const MENU_TEXT =
  `📱 *MENU PELANGGAN*
${'─'.repeat(30)}

📋 *Perintah Tersedia:*

🔹 \`menu\` — Tampilkan bantuan ini
🔹 \`info\` — Ringkasan ONU Anda
🔹 \`cekterhubung\` — Daftar host terhubung
🔹 \`gantissid\` _nama_ — Ubah nama WiFi
🔹 \`gantisandi\` _sandi_ — Ubah password (min 8 karakter)
🔹 \`reboot\` — Restart ONU
🔹 \`daftar\` _tag/nomor_ — Daftarkan nomor WA (wajib jika pakai @lid)

${'─'.repeat(30)}
💡 *Contoh:* \`gantissid RumahKu\`

ℹ️ _Nomor admin: ketik \`adminmenu\` (hanya nomor terdaftar di settings)_`;

const ADMIN_MENU_TEXT =
  `🛠️ *MENU ADMIN*
${'─'.repeat(30)}

📋 *Perintah Admin:*

🔹 \`listonu\` — Semua ONU yang punya tag
🔹 \`info\` _TAG_ — Data ONU untuk tag tersebut
🔹 \`cekterhubung\` _TAG_ — Host untuk tag tersebut
🔹 \`gantissid\` _TAG_ _namaSSID_ — Ubah SSID
🔹 \`gantisandi\` _TAG_ _sandiBaru_ — Ubah password
🔹 \`reboot\` _TAG_ — Restart ONU

${'─'.repeat(30)}
💡 *Contoh:*
\`info 081234567890\`
\`gantissid 081234567890 WiFiPelanggan\`
\`gantisandi 081234567890 sandiBaru123\`

ℹ️ _Tanpa TAG = perintah pelanggan untuk device yang terikat ke WA Anda._`;

let sockInstance = null;

export async function sendWhatsAppMessage(jid, text) {
  if (!sockInstance || !sockInstance.user) {
    logger.error('WhatsApp bot belum terhubung atau sesi belum aktif untuk mengirim pesan.');
    return false;
  }
  try {
    let rawJid = jid.replace(/\D/g, '');
    // Normalisasi nomor Indonesia (08... -> 628...)
    if (rawJid.startsWith('0')) {
      rawJid = '62' + rawJid.slice(1);
    }
    const target = jid.includes('@') ? jid : `${rawJid}@s.whatsapp.net`;
    await sockInstance.sendMessage(target, { text });
    return true;
  } catch (e) {
    logger.error(`Gagal mengirim pesan WhatsApp ke ${jid}:`, e.message || e);
    return false;
  }
}

export async function startWhatsAppBot() {
  const authFolder = path.resolve(projectRoot, getSetting('whatsapp_auth_folder', 'auth_baileys'));
  const lidMapPath = path.resolve(projectRoot, getSetting('whatsapp_lid_map_file', 'data/wa-lid-map.json'));
  const lidStore = new WaLidStore(lidMapPath);

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['ALIJAYA WEBPORTAL', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    getMessage: true,
    logger: pino({ level: 'silent' })
  });

  sockInstance = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      logger.info('WhatsApp: pindai QR di terminal untuk login');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn(
        `WhatsApp terputus (kode ${code}). ` +
          (code === DisconnectReason.loggedOut
            ? 'Sesi logout — hapus folder auth dan pindai QR lagi.'
            : 'Mencoba reconnect dalam 3 detik...')
      );
      if (shouldReconnect) {
        setTimeout(() => startWhatsAppBot(), 3000);
      }
    } else if (connection === 'open') {
      logger.info('WhatsApp bot terhubung');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        if (m.key.fromMe) continue;
        const text = getMessageText(m);
        if (!text) continue;

        const remote = m.key.remoteJid;
        if (!remote || remote.endsWith('@g.us')) continue;

        const adminSet = loadWhatsappAdminSet();
        const isAdmin = isWhatsappAdminKey(m.key, adminSet);
        const parsed = parseCommand(text, isAdmin);
        if (!parsed) continue;

        const reply = async (msg) => {
          await sock.sendMessage(remote, { text: msg }, { quoted: m });
        };

        if (parsed.cmd === 'menu') {
          let body = MENU_TEXT;
          if (isAdmin) body += '\n\n_Anda admin — ketik `adminmenu` untuk perintah kelola semua tag._';
          await reply(body);
          continue;
        }

        if (parsed.cmd === 'adminmenu') {
          if (!isAdmin) {
            await reply('❌ Perintah ini khusus nomor admin (pengaturan whatsapp_admin_numbers).');
            continue;
          }
          await reply(ADMIN_MENU_TEXT);
          continue;
        }

        if (parsed.cmd === 'listonu' && parsed.admin) {
          if (!isAdmin) {
            await reply('❌ Akses ditolak. Perintah ini khusus admin.');
            continue;
          }
          const res = await customerDevice.listDevicesWithTags(300);
          if (!res.ok) {
            await reply('❌ ' + (res.message || 'Gagal mengambil daftar.'));
            continue;
          }
          const body = formatListOnu(res.devices);
          const chunks = splitWaChunks(body);
          for (const ch of chunks) {
            await reply(ch);
          }
          continue;
        }

        if (parsed.admin && parsed.targetTag) {
          if (!isAdmin) {
            await reply('❌ Akses ditolak. Perintah ini khusus admin.');
            continue;
          }
          const targetTag = await resolveTargetTagForAdmin(parsed.targetTag);
          if (!targetTag) {
            await reply(`❌ Tag *${parsed.targetTag}* tidak ditemukan di GenieACS.`);
            continue;
          }
          if (parsed.cmd === 'info') {
            const data = await customerDevice.getCustomerDeviceData(targetTag);
            await reply(formatInfo(data));
            continue;
          }
          if (parsed.cmd === 'cekterhubung') {
            const data = await customerDevice.getCustomerDeviceData(targetTag);
            await reply(formatCekTerhubung(data));
            continue;
          }
          if (parsed.cmd === 'gantissid') {
            if (!parsed.rest) {
              await reply('❌ Format salah. Gunakan: \`gantissid TAG namaSSID\`');
              continue;
            }
            const ok = await customerDevice.updateSSID(targetTag, parsed.rest);
            if (ok) {
              await reply(`✅ SSID untuk *${targetTag}* berhasil diubah menjadi:\n\n📶 *${parsed.rest}*`);
              // Kirim notifikasi ke pelanggan
              const companyHeader = getSetting('company_header', 'ALIJAYA WEBPORTAL');
              const notifMsg = `📢 *NOTIFIKASI PERUBAHAN WIFI*\n\n` +
                `Yth. Pelanggan ${companyHeader},\n\n` +
                `SSID WiFi Anda telah diubah oleh admin menjadi:\n\n` +
                `📶 *${parsed.rest}*\n\n` +
                `Silakan hubungi admin jika Anda memiliki pertanyaan.`;
              const notifSent = await notifyCustomer(sock, lidStore, targetTag, notifMsg);
              if (notifSent) {
                await reply(`📤 Notifikasi terkirim ke pelanggan *${targetTag}*`);
              } else {
                await reply(`⚠️ Tidak dapat mengirim notifikasi ke pelanggan *${targetTag}* (nomor belum terdaftar)`);
              }
            } else {
              await reply('❌ Gagal mengubah SSID.');
            }
            continue;
          }
          if (parsed.cmd === 'gantisandi') {
            if (!parsed.rest || parsed.rest.length < 8) {
              await reply('❌ Sandi minimal 8 karakter.');
              continue;
            }
            const ok = await customerDevice.updatePassword(targetTag, parsed.rest);
            if (ok) {
              await reply('✅ Password WiFi berhasil diubah.');
              // Kirim notifikasi ke pelanggan
              const companyHeader = getSetting('company_header', 'ALIJAYA WEBPORTAL');
              const notifMsg = `📢 *NOTIFIKASI PERUBAHAN PASSWORD*\n\n` +
                `Yth. Pelanggan ${companyHeader},\n\n` +
                `Password WiFi Anda telah diubah oleh admin menjadi:\n\n` +
                `🔑 *${parsed.rest}*\n\n` +
                `Silakan gunakan password baru untuk terhubung ke WiFi.\n` +
                `Hubungi admin jika Anda memiliki pertanyaan.`;
              const notifSent = await notifyCustomer(sock, lidStore, targetTag, notifMsg);
              if (notifSent) {
                await reply(`📤 Notifikasi terkirim ke pelanggan *${targetTag}*`);
              } else {
                await reply(`⚠️ Tidak dapat mengirim notifikasi ke pelanggan *${targetTag}* (nomor belum terdaftar)`);
              }
            } else {
              await reply('❌ Gagal mengubah password.');
            }
            continue;
          }
          if (parsed.cmd === 'reboot') {
            const r = await customerDevice.requestReboot(targetTag);
            await reply(`🔄 *${targetTag}*\n\n${r.message}`);
            continue;
          }
        }

        if (parsed.cmd === 'daftar') {
          if (!parsed.rest) {
            await reply('❌ Format salah. Gunakan:\n\n\`daftar 081234567890\`\n\n(gunakan tag/nomor yang sama dengan di GenieACS)');
            continue;
          }
          const found = await customerDevice.findDeviceWithTagVariants(parsed.rest);
          if (!found) {
            await reply('❌ Tag/nomor tidak ditemukan di GenieACS. Periksa penulisan atau hubungi admin.');
            continue;
          }
          const nk = normalizeKey(m.key);
          lidStore.set(remote, found.canonicalTag);
          if (nk.senderLid) lidStore.set(nk.senderLid, found.canonicalTag);
          if (nk.senderPn) lidStore.set(nk.senderPn, found.canonicalTag);
          await reply(`✅ Berhasil! Nomor WA ini diikat ke tag:\n\n📍 *${found.canonicalTag}*\n\nSilakan gunakan perintah lain.`);
          continue;
        }

        let tag = await resolveCustomerTag(m.key, lidStore);
        if (!tag) {
          await reply(
            '❌ Nomor/tag Anda belum dikenali (sering terjadi jika WA memakai @lid).\n\n' +
              'Kirim sekali:\n\`daftar NOMORATAUTAG\`\n(sama persis dengan tag di GenieACS), lalu ulangi perintah.'
          );
          continue;
        }

        if (parsed.cmd === 'info') {
          const data = await customerDevice.getCustomerDeviceData(tag);
          await reply(formatInfo(data));
          continue;
        }

        if (parsed.cmd === 'cekterhubung') {
          const data = await customerDevice.getCustomerDeviceData(tag);
          await reply(formatCekTerhubung(data));
          continue;
        }

        if (parsed.cmd === 'gantissid') {
          if (!parsed.rest) {
            await reply('❌ Format salah. Gunakan:\n\n\`gantissid NamaWiFiBaru\`');
            continue;
          }
          const ok = await customerDevice.updateSSID(tag, parsed.rest);
          await reply(ok ? `✅ SSID berhasil diubah menjadi:\n\n📶 *${parsed.rest}*` : '❌ Gagal mengubah SSID. Coba lagi atau hubungi admin.');
          continue;
        }

        if (parsed.cmd === 'gantisandi') {
          if (!parsed.rest || parsed.rest.length < 8) {
            await reply('❌ Format salah. Gunakan:\n\n\`gantisandi sandibarumin8huruf\`\n\nSandi minimal 8 karakter.');
            continue;
          }
          const ok = await customerDevice.updatePassword(tag, parsed.rest);
          await reply(ok ? '✅ Password WiFi berhasil diubah.' : '❌ Gagal mengubah password.');
          continue;
        }

        if (parsed.cmd === 'reboot') {
          const r = await customerDevice.requestReboot(tag);
          await reply(`🔄 *Reboot ONU*\n\n${r.message}`);
        }
      } catch (e) {
        logger.error('WhatsApp message handler:', e.message || e);
      }
    }
  });
}
