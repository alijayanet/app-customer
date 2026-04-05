const express = require('express');
const customerDevice = require('../services/customerDeviceService');
const { getSettingsWithCache } = require('../config/settingsManager');
const router = express.Router();

function dashboardNotif(message, type = 'success') {
  if (!message) return null;
  return { text: message, type };
}

const {
  findDeviceByTag,
  getCustomerDeviceData,
  fallbackCustomer,
  updateSSID,
  updatePassword,
  requestReboot,
  updateCustomerTag
} = customerDevice;

router.get('/login', (req, res) => {
  const settings = getSettingsWithCache();
  res.render('login', { error: null, settings });
});

router.post('/login', async (req, res) => {
  const { phone } = req.body;
  const settings = getSettingsWithCache();
  if (!(await findDeviceByTag(phone))) {
    return res.render('login', { error: 'ID/Tag tidak valid atau belum terdaftar.', settings });
  }
  req.session.phone = phone;
  return res.redirect('/customer/dashboard');
});

router.get('/dashboard', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const data = await getCustomerDeviceData(phone);
  res.render('dashboard', {
    customer: data || fallbackCustomer(phone),
    connectedUsers: data ? data.connectedUsers : [],
    notif: data ? null : dashboardNotif('Data perangkat tidak ditemukan.', 'warning')
  });
});

router.post('/change-ssid', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const { ssid } = req.body;
  const ok = await updateSSID(phone, ssid);
  const data = await getCustomerDeviceData(phone);
  res.render('dashboard', {
    customer: data || fallbackCustomer(phone),
    connectedUsers: data ? data.connectedUsers : [],
    notif: ok
      ? dashboardNotif('Nama WiFi (SSID) berhasil diubah.', 'success')
      : dashboardNotif('Gagal mengubah SSID.', 'danger')
  });
});

router.post('/change-password', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const { password } = req.body;
  const ok = await updatePassword(phone, password);
  const data = await getCustomerDeviceData(phone);
  res.render('dashboard', {
    customer: data || fallbackCustomer(phone),
    connectedUsers: data ? data.connectedUsers : [],
    notif: ok
      ? dashboardNotif('Password WiFi berhasil diubah.', 'success')
      : dashboardNotif('Gagal mengubah password. Pastikan minimal 8 karakter.', 'danger')
  });
});

router.post('/reboot', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const r = await requestReboot(phone);
  const notif = r.ok
    ? dashboardNotif(
        'Perangkat berhasil direboot. Silakan tunggu beberapa menit hingga perangkat online kembali.',
        'success'
      )
    : dashboardNotif(r.message || 'Gagal reboot.', 'danger');
  const data = await getCustomerDeviceData(phone);
  res.render('dashboard', {
    customer: data || fallbackCustomer(phone),
    connectedUsers: data ? data.connectedUsers : [],
    notif
  });
});

router.post('/change-tag', async (req, res) => {
  const oldTag = req.session && req.session.phone;
  const newTag = (req.body.newTag || '').trim();
  if (!oldTag) return res.redirect('/customer/login');
  if (!newTag || newTag === oldTag) {
    const data = await getCustomerDeviceData(oldTag);
    return res.render('dashboard', {
      customer: data || fallbackCustomer(oldTag),
      connectedUsers: data ? data.connectedUsers : [],
      notif: dashboardNotif('ID/Tag baru tidak boleh kosong atau sama dengan yang lama.', 'warning')
    });
  }
  const tagResult = await updateCustomerTag(oldTag, newTag);
  let notif = null;
  let resolvedPhone = oldTag;
  if (tagResult.ok) {
    req.session.phone = newTag;
    resolvedPhone = newTag;
    notif = dashboardNotif('ID/Tag berhasil diubah.', 'success');
  } else {
    notif = dashboardNotif(tagResult.message || 'Gagal mengubah ID/Tag pelanggan.', 'danger');
  }
  const data = await getCustomerDeviceData(resolvedPhone);
  res.render('dashboard', {
    customer: data || fallbackCustomer(resolvedPhone),
    connectedUsers: data ? data.connectedUsers : [],
    notif
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/customer/login');
  });
});

module.exports = router;
