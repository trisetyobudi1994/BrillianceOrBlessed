// server/server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const midtransClient = require('midtrans-client');
const GameEngine = require('./gameEngine');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../client')));

// ----------------------------------------------------
// 1. KONEKSI DATABASE (MongoDB)
// ----------------------------------------------------
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/brilliance_blessed';
mongoose.connect(MONGO_URI)
  .then(() => console.log('[DB] Terhubung ke Database MongoDB'))
  .catch(err => console.error('[DB Error]', err));

// Schema Pengguna (Daftar dengan Nomor HP)
const UserSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  gold: { type: Number, default: 1000 },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);

// ----------------------------------------------------
// 2. INTEGRASI PAYMENT GATEWAY (Midtrans Snap)
// ----------------------------------------------------
// Dapatkan Server Key dari Dashboard Midtrans (Sandbox / Production)
const snap = new midtransClient.Snap({
  isProduction: false, // Ubah ke true jika sudah live dengan rekening bank asli
  serverKey: process.env.MIDTRANS_SERVER_KEY || 'SB-Mid-server-YOUR_SERVER_KEY',
  clientKey: process.env.MIDTRANS_CLIENT_KEY || 'SB-Mid-client-YOUR_CLIENT_KEY'
});

// Endpoint 1: Register / Login dengan Nomor HP
app.post('/api/auth/phone', async (req, res) => {
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'Nomor HP wajib diisi!' });

  try {
    let user = await User.findOne({ phone });
    if (!user) {
      user = new User({ phone, name: name || `Pemain_${phone.slice(-4)}` });
      await user.save();
    }
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Gagal memproses pendaftaran' });
  }
});

// Endpoint 2: Buat Transaksi Pembayaran Real-Time (Top Up Gold)
app.post('/api/payment/charge', async (req, res) => {
  const { phone, amount, goldAmount } = req.body;

  try {
    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });

    const orderId = `TOPUP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const parameter = {
      transaction_details: {
        order_id: orderId,
        gross_amount: amount // Jumlah Rupiah (misal: 10000)
      },
      customer_details: {
        first_name: user.name,
        phone: user.phone
      },
      item_details: [{
        id: 'GOLD_PACK',
        price: amount,
        quantity: 1,
        name: `Topup ${goldAmount} Gold`
      }]
    };

    const transaction = await snap.createTransaction(parameter);
    res.json({ success: true, token: transaction.token, redirect_url: transaction.redirect_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal membuat transaksi pembayaran' });
  }
});

// Endpoint 3: Webhook Notifikasi Midtrans (Otomatis Tambah Gold Saat Pembayaran Berhasil)
app.post('/api/payment/notification', async (req, res) => {
  try {
    const statusResponse = await snap.transaction.notification(req.body);
    const orderId = statusResponse.order_id;
    const transactionStatus = statusResponse.transaction_status;
    const fraudStatus = statusResponse.fraud_status;

    if (transactionStatus === 'capture' || transactionStatus === 'settlement') {
      if (fraudStatus === 'challenge') {
        // Pembayaran dicurigai
      } else if (fraudStatus === 'accept') {
        // PEMBAYARAN SUKSES LUNAS DARI REKENING BANK / QRIS
        console.log(`[Payment Success] Order ${orderId} telah dibayar lunas.`);
        // Tambahkan logic update saldo Gold user di MongoDB di sini
      }
    }
    res.status(200).send('OK');
  } catch (err) {
    res.status(500).send('Webhook Error');
  }
});

// ----------------------------------------------------
// 3. GAME ENGINE & REALTIME SOCKETS
// ----------------------------------------------------
const rooms = new Map();

io.on('connection', (socket) => {
  socket.on('join_room', async ({ roomId, phone }) => {
    let user = await User.findOne({ phone });
    if (!user) return socket.emit('error_msg', 'Silakan daftar terlebih dahulu!');

    let room = rooms.get(roomId);
    if (!room) {
      room = new GameEngine(roomId);
      rooms.set(roomId, room);
    }

    const joined = room.addPlayer(socket.id, user.name, 'avatar1');
    if (!joined) {
      socket.emit('error_msg', 'Room Penuh!');
      return;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    io.to(roomId).emit('room_state_update', room.getSnapshot());
  });

  socket.on('req_spin_wheel', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const result = room.spinLuckyWheel(socket.id);
    if (result.success) {
      io.to(socket.roomId).emit('wheel_spun', { playerId: socket.id, ...result, gameState: room.getSnapshot() });
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        room.removePlayer(socket.id);
        if (room.players.size === 0) rooms.delete(socket.roomId);
        else io.to(socket.roomId).emit('room_state_update', room.getSnapshot());
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[Server] Game berjalan di port ${PORT}`));
