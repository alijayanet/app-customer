const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getSettingsWithCache, getSetting } = require('../config/settingsManager');
const router = express.Router();

// Ganti findDeviceByTag dengan implementasi pencarian device langsung di sini atau gunakan dari modul lain yang masih ada
async function findDeviceByTag(phone) {
  const settings = getSettingsWithCache();
  const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
  const username = settings.genieacs_username || '';
  const password = settings.genieacs_password || '';
  try {
    const response = await axios.get(`${genieacsUrl}/devices`, {
      params: {
        query: JSON.stringify({ _tags: phone })
      },
      auth: { username, password }
    });
    if (response.data && response.data.length > 0) {
      return response.data[0]; // Device ditemukan
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Simpan OTP sementara di memory (bisa diganti redis/db)
const otpStore = {};

// parameterPaths dan getParameterWithPaths dari WhatsApp bot
const parameterPaths = {
  rxPower: [
    'VirtualParameters.RXPower',
    'VirtualParameters.redaman',
    'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower'
  ],
  pppoeIP: [
    'VirtualParameters.pppoeIP',
    'VirtualParameters.pppIP',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress'
  ],
  pppUsername: [
    'VirtualParameters.pppoeUsername',
    'VirtualParameters.pppUsername',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username'
  ],
  uptime: [
    'VirtualParameters.getdeviceuptime',
    'InternetGatewayDevice.DeviceInfo.UpTime'
  ],
  userConnected: [
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations'
  ]
};
function getParameterWithPaths(device, paths) {
  for (const path of paths) {
    const parts = path.split('.');
    let value = device;
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
        if (value && value._value !== undefined) value = value._value;
      } else {
        value = undefined;
        break;
      }
    }
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return 'N/A';
}

// Helper: Ambil info perangkat dan user terhubung dari GenieACS
async function getCustomerDeviceData(phone) {
  const device = await findDeviceByTag(phone);
  if (!device) return null;
  // Ambil SSID
  const ssid = device?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.SSID?._value || '-';
  // Status online/offline
  const lastInform =
    device?._lastInform
      ? new Date(device._lastInform).toLocaleString('id-ID')
      : device?.Events?.Inform
        ? new Date(device.Events.Inform).toLocaleString('id-ID')
        : device?.InternetGatewayDevice?.DeviceInfo?.['1']?.LastInform?._value
          ? new Date(device.InternetGatewayDevice.DeviceInfo['1'].LastInform._value).toLocaleString('id-ID')
          : '-';
  const status = lastInform !== '-' ? 'Online' : 'Unknown';
  // User terhubung (WiFi)
  let connectedUsers = [];
  try {
    const hosts = device?.InternetGatewayDevice?.LANDevice?.['1']?.Hosts?.Host;
    if (hosts && typeof hosts === 'object') {
      for (const key in hosts) {
        if (!isNaN(key)) {
          const entry = hosts[key];
          connectedUsers.push({
            hostname: typeof entry?.HostName === 'object' ? entry?.HostName?._value || '-' : entry?.HostName || '-',
            ip: typeof entry?.IPAddress === 'object' ? entry?.IPAddress?._value || '-' : entry?.IPAddress || '-',
            mac: typeof entry?.MACAddress === 'object' ? entry?.MACAddress?._value || '-' : entry?.MACAddress || '-',
            iface: typeof entry?.InterfaceType === 'object' ? entry?.InterfaceType?._value || '-' : entry?.InterfaceType || entry?.Interface || '-',
            waktu: entry?.Active?._value === 'true' ? 'Aktif' : 'Tidak Aktif'
          });
        }
      }
    }
  } catch (e) {}
  // Ambil data dengan helper agar sama dengan WhatsApp
  const rxPower = getParameterWithPaths(device, parameterPaths.rxPower);
  const pppoeIP = getParameterWithPaths(device, parameterPaths.pppoeIP);
  const pppoeUsername = getParameterWithPaths(device, parameterPaths.pppUsername);
  const serialNumber =
    device?.DeviceID?.SerialNumber ||
    device?.InternetGatewayDevice?.DeviceInfo?.SerialNumber?._value ||
    device?.InternetGatewayDevice?.DeviceInfo?.['1']?.SerialNumber?._value ||
    device?.SerialNumber ||
    '-';
  const productClass =
    device?.DeviceID?.ProductClass ||
    device?.InternetGatewayDevice?.DeviceInfo?.ProductClass?._value ||
    device?.InternetGatewayDevice?.DeviceInfo?.['1']?.ProductClass?._value ||
    device?.ProductClass ||
    '-';
  let lokasi = device?.Tags || '-';
  if (Array.isArray(lokasi)) lokasi = lokasi.join(', ');
  const softwareVersion = device?.InternetGatewayDevice?.DeviceInfo?.SoftwareVersion?._value || '-';
  const model =
    device?.InternetGatewayDevice?.DeviceInfo?.ModelName?._value ||
    device?.InternetGatewayDevice?.DeviceInfo?.['1']?.ModelName?._value ||
    device?.ModelName ||
    '-';
  const uptime = getParameterWithPaths(device, parameterPaths.uptime);
  const totalAssociations = getParameterWithPaths(device, parameterPaths.userConnected);
  return {
    phone,
    ssid,
    status,
    lastInform,
    connectedUsers,
    rxPower,
    pppoeIP,
    pppoeUsername,
    serialNumber,
    productClass,
    lokasi,
    softwareVersion,
    model,
    uptime,
    totalAssociations
  };
}

// Helper: Update SSID (real ke GenieACS)
async function updateSSID(phone, newSSID) {
  try {
    const device = await findDeviceByTag(phone);
    if (!device) return false;
    const deviceId = device._id;
    const encodedDeviceId = encodeURIComponent(deviceId);
    const settings = getSettingsWithCache();
    const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
    const username = settings.genieacs_username || '';
    const password = settings.genieacs_password || '';
    // Update SSID 2.4GHz
    await axios.post(
      `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
      {
        name: "setParameterValues",
        parameterValues: [
          ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", newSSID, "xsd:string"]
        ]
      },
      { auth: { username, password } }
    );
    // Update SSID 5GHz (index 5-8, ambil yang berhasil saja)
    const newSSID5G = `${newSSID}-5G`;
    const ssid5gIndexes = [5, 6, 7, 8];
    for (const idx of ssid5gIndexes) {
      try {
        await axios.post(
          `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
          {
            name: "setParameterValues",
            parameterValues: [
              [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.SSID`, newSSID5G, "xsd:string"]
            ]
          },
          { auth: { username, password } }
        );
        break;
      } catch (e) {}
    }
    // Hanya refresh, tidak perlu reboot
    await axios.post(
      `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
      { name: "refreshObject", objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration" },
      { auth: { username, password } }
    );
    return true;
  } catch (e) {
    return false;
  }
}
// Helper: Update Password (real ke GenieACS)
async function updatePassword(phone, newPassword) {
  try {
    if (newPassword.length < 8) return false;
    const device = await findDeviceByTag(phone);
    if (!device) return false;
    const deviceId = device._id;
    const encodedDeviceId = encodeURIComponent(deviceId);
    const settings = getSettingsWithCache();
    const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
    const username = settings.genieacs_username || '';
    const password = settings.genieacs_password || '';
    const tasksUrl = `${genieacsUrl}/devices/${encodedDeviceId}/tasks`;
    // Update password 2.4GHz
    await axios.post(tasksUrl, {
      name: "setParameterValues",
      parameterValues: [
        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", newPassword, "xsd:string"],
        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase", newPassword, "xsd:string"]
      ]
    }, { auth: { username, password } });
    // Update password 5GHz
    await axios.post(tasksUrl, {
      name: "setParameterValues",
      parameterValues: [
        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase", newPassword, "xsd:string"],
        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.KeyPassphrase", newPassword, "xsd:string"]
      ]
    }, { auth: { username, password } });
    // Refresh
    await axios.post(tasksUrl, {
      name: "refreshObject",
      objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration"
    }, { auth: { username, password } });
    return true;
  } catch (e) {
    return false;
  }
}

// GET: Login page
router.get('/login', (req, res) => {
  const settings = getSettingsWithCache();
  res.render('login', { 
    error: null,
    settings: settings
  });
});

// POST: Proses login
router.post('/login', async (req, res) => {
  const { phone } = req.body;
  const settings = getSettingsWithCache();
  if (!await findDeviceByTag(phone)) { // Changed from isValidCustomer
    return res.render('login', { error: 'Nomor HP tidak valid atau belum terdaftar.' });
  }
  if (settings.customerPortalOtp) {
    // Generate OTP sesuai jumlah digit di settings
    const otpLength = settings.otp_length || 6;
    const min = Math.pow(10, otpLength - 1);
    const max = Math.pow(10, otpLength) - 1;
    const otp = Math.floor(min + Math.random() * (max - min)).toString();
    otpStore[phone] = { otp, expires: Date.now() + 5 * 60 * 1000 };
    
    // Kirim OTP ke WhatsApp pelanggan
    try {
      const waJid = phone.replace(/^0/, '62') + '@s.whatsapp.net';
      const msg = `🔐 *KODE OTP PORTAL PELANGGAN*\n\n` +
        `Kode OTP Anda adalah: *${otp}*\n\n` +
        `⏰ Kode ini berlaku selama 5 menit\n` +
        `🔒 Jangan bagikan kode ini kepada siapapun`;
      
      // Removed sendMessage call
    } catch (error) {
      console.error(`Gagal mengirim OTP ke ${phone}:`, error);
    }
    return res.render('otp', { phone, error: null, otp_length: otpLength });
  } else {
    req.session.phone = phone;
    return res.redirect('/customer/dashboard');
  }
});

// GET: Halaman OTP
router.get('/otp', (req, res) => {
  const { phone } = req.query;
  const settings = getSettingsWithCache();
  res.render('otp', { phone, error: null, otp_length: settings.otp_length || 6 });
});

// POST: Verifikasi OTP
router.post('/otp', (req, res) => {
  const { phone, otp } = req.body;
  const data = otpStore[phone];
  const settings = getSettingsWithCache();
  if (!data || data.otp !== otp || Date.now() > data.expires) {
    return res.render('otp', { phone, error: 'OTP salah atau sudah kadaluarsa.', otp_length: settings.otp_length || 6 });
  }
  // Sukses login
  delete otpStore[phone];
  req.session = req.session || {};
  req.session.phone = phone;
  return res.redirect('/customer/dashboard');
});

// GET: Dashboard pelanggan
router.get('/dashboard', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const data = await getCustomerDeviceData(phone);
  if (!data) return res.render('dashboard', { customer: { phone, ssid: '-', status: 'Tidak ditemukan', lastChange: '-' }, connectedUsers: [], notif: 'Data perangkat tidak ditemukan.' });
  res.render('dashboard', { customer: data, connectedUsers: data.connectedUsers });
});

// POST: Ganti SSID
router.post('/change-ssid', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const { ssid } = req.body;
  const ok = await updateSSID(phone, ssid);
  if (ok) {
    // Kirim notifikasi WhatsApp ke pelanggan
    const waJid = phone.replace(/^0/, '62') + '@s.whatsapp.net';
    const msg = `✅ *PERUBAHAN NAMA WIFI*\n\nNama WiFi Anda telah diubah menjadi:\n• WiFi 2.4GHz: ${ssid}\n• WiFi 5GHz: ${ssid}-5G\n\nSilakan hubungkan ulang perangkat Anda ke WiFi baru.`;
    try { 
      // Removed sendMessage call
    } catch (e) {}
  }
  const data = await getCustomerDeviceData(phone);
  res.render('dashboard', { customer: data || { phone, ssid: '-', status: '-', lastChange: '-' }, connectedUsers: data ? data.connectedUsers : [], notif: ok ? 'Nama WiFi (SSID) berhasil diubah.' : 'Gagal mengubah SSID.' });
});

// POST: Ganti Password
router.post('/change-password', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const { password } = req.body;
  const ok = await updatePassword(phone, password);
  if (ok) {
    // Kirim notifikasi WhatsApp ke pelanggan
    const waJid = phone.replace(/^0/, '62') + '@s.whatsapp.net';
    const msg = `✅ *PERUBAHAN PASSWORD WIFI*\n\nPassword WiFi Anda telah diubah menjadi:\n• Password Baru: ${password}\n\nSilakan hubungkan ulang perangkat Anda dengan password baru.`;
    try { 
      // Removed sendMessage call
    } catch (e) {}
  }
  const data = await getCustomerDeviceData(phone);
  res.render('dashboard', { customer: data || { phone, ssid: '-', status: '-', lastChange: '-' }, connectedUsers: data ? data.connectedUsers : [], notif: ok ? 'Password WiFi berhasil diubah.' : 'Gagal mengubah password.' });
});

// POST: Reboot perangkat
router.post('/reboot', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const device = await findDeviceByTag(phone);
  let notif = '';
  if (device && device._id) {
    const settings = getSettingsWithCache();
    const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
    const username = settings.genieacs_username || '';
    const password = settings.genieacs_password || '';
    try {
      await axios.post(
        `${genieacsUrl}/devices/${encodeURIComponent(device._id)}/tasks`,
        { name: 'reboot', timestamp: new Date().toISOString() },
        { auth: { username, password } }
      );
      notif = 'Perangkat berhasil direboot. Silakan tunggu beberapa menit hingga perangkat online kembali.';
    } catch (e) {
      notif = 'Gagal mengirim perintah reboot ke perangkat.';
    }
  } else {
    notif = 'Perangkat tidak ditemukan.';
  }
  const data = await getCustomerDeviceData(phone);
  res.render('dashboard', { customer: data || { phone, ssid: '-', status: '-', lastChange: '-' }, connectedUsers: data ? data.connectedUsers : [], notif });
});

// POST: Ubah ID/Tag pelanggan
router.post('/change-tag', async (req, res) => {
  const oldTag = req.session && req.session.phone;
  const newTag = (req.body.newTag || '').trim();
  if (!oldTag) return res.redirect('/customer/login');
  if (!newTag || newTag === oldTag) {
    const data = await getCustomerDeviceData(oldTag);
    return res.render('dashboard', { customer: data || { phone: oldTag, ssid: '-', status: '-', lastChange: '-' }, connectedUsers: data ? data.connectedUsers : [], notif: 'ID/Tag baru tidak boleh kosong atau sama dengan yang lama.' });
  }
  const device = await findDeviceByTag(oldTag);
  let notif = '';
  if (device && device._id) {
    const settings = getSettingsWithCache();
    const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
    const username = settings.genieacs_username || '';
    const password = settings.genieacs_password || '';
    try {
      // Update tag: hapus tag lama, tambah tag baru
      const tags = Array.isArray(device.Tags) ? device.Tags.filter(t => t !== oldTag) : [];
      tags.push(newTag);
      // PUT hanya _id dan Tags
      await axios.put(
        `${genieacsUrl}/devices/${encodeURIComponent(device._id)}`,
        { _id: device._id, Tags: tags },
        { auth: { username, password } }
      );
      req.session.phone = newTag; // Update session ke tag baru HANYA jika berhasil
      notif = 'ID/Tag berhasil diubah.';
    } catch (e) {
      notif = 'Gagal mengubah ID/Tag pelanggan.';
    }
  } else {
    notif = 'Perangkat tidak ditemukan.';
  }
  const data = await getCustomerDeviceData(notif === 'ID/Tag berhasil diubah.' ? newTag : oldTag);
  res.render('dashboard', { customer: data || { phone: notif === 'ID/Tag berhasil diubah.' ? newTag : oldTag, ssid: '-', status: '-', lastChange: '-' }, connectedUsers: data ? data.connectedUsers : [], notif });
});

// POST: Logout pelanggan (letakkan sebelum module.exports)
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/customer/login');
  });
});

module.exports = router; 