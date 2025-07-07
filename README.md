# Portal Pelanggan GenieACS

Aplikasi ini adalah portal web sederhana untuk pelanggan ISP yang terintegrasi dengan GenieACS. Pelanggan dapat login menggunakan nomor HP yang sudah di-tag di GenieACS dan melihat/mengelola informasi perangkat mereka.

---

## Fitur Utama
- Login pelanggan berbasis nomor HP (tag di GenieACS)
- Menampilkan status perangkat, SSID, RX Power, IP PPPoE, dan info lain dari GenieACS
- Mengubah SSID dan password WiFi perangkat pelanggan
- Tidak ada integrasi WhatsApp, Mikrotik, PPPoE, RX Power monitoring, atau OTP

---

## Requirement
- Node.js v14, v16, atau lebih baru
- GenieACS sudah berjalan dan dapat diakses dari aplikasi ini

---

## Instalasi
1. **Clone repository**
2. **Install dependensi**
   ```sh
   npm install
   ```
3. **Konfigurasi**
   - Edit file `settings.json` sesuai kebutuhan:
     ```json
     {
       "genieacs_url": "http://localhost:7557",
       "genieacs_username": "admin",
       "genieacs_password": "admin",
       "company_header": "NAMA ISP ANDA",
       "footer_info": "Info tambahan perusahaan",
       "server_port": 3001,
       "server_host": "localhost"
     }
     ```
   - Tidak perlu file `.env` kecuali ingin override konfigurasi dengan environment variable.

---

## Menjalankan Aplikasi
```sh
npm start
```
Akses portal pelanggan di `http://localhost:3001/customer/login` (atau port sesuai settings).

---

## Struktur Project (Utama)
- `app-customer.js` : File utama aplikasi
- `config/` : Konfigurasi dan helper untuk GenieACS
- `routes/customerPortal.js` : Route portal pelanggan
- `views/` : Template EJS untuk tampilan web
- `settings.json` : Konfigurasi aplikasi

---

## Catatan
- Tidak ada dependensi WhatsApp, Mikrotik, PPPoE, RX Power, atau OTP
- Hanya fokus pada portal pelanggan GenieACS
- Kompatibel dengan Node.js v14, v16, dan lebih baru

---

## Lisensi
MIT
