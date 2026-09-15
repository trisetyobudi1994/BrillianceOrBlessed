require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const midtransClient = require('midtrans-client');
const GameEngine = require('./gameEngine');

// 1. PENANGKAL CRASH GLOBAL (CRITICAL ERROR GUARD)
process.on('uncaughtException', (err) => {
  console.error('🚨 UNCAUGHT EXCEPTION:', err.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('🚨 UNHANDLED REJECTION:', reason);
});

const app = express();
const server = http.createServer(app);

// Konfigurasi CORS & Parser
app.use(cors({ origin: '*' }));
app.use(express.json());

// Sajikan aset statis client (opsional jika disatukan)
app.use(express.static(path.join(__dirname, '../client')));

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// 2. KONEKSI MONGODB SAFE FALLBACK
if (process.env.MONGO_URI) {
  mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Error:', err.message));
} else {
  console.warn('⚠️ MONGO_URI tidak ditemukan. Kuis menggunakan data fallback.');
}

// 3. HEALTH CHECK ENDPOINT
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', uptime: process.uptime(), timestamp: Date.now() });
});

// 4. MANAJEMEN ARENA / ROOM
const activeGames = new Map(); // roomId -> GameEngine

function getOrCreateGame(roomId) {
  if (!activeGames.has(roomId)) {
    const engine = new GameEngine(roomId);
    
    // Pemicu callback otomatis saat timer berkurang
    engine.onTick = () => {
      io.to(roomId).emit('room_state_update', engine.getSnapshot());
    };

    activeGames.set(roomId, engine);
  }
  return activeGames.get(roomId);
}

// 5. EVENT HANDLER SOCKET.IO SAFE WRAPPED
io.on('connection', (socket) => {
  console.log('⚡ Player terhubung:', socket.id);

  // Bergabung ke Arena
  socket.on('join_room', (data) => {
    try {
      if (!data || !data.roomId) return;
      const { roomId, name, phone } = data;
      
      socket.join(roomId);
      socket.roomId = roomId;

      const game = getOrCreateGame(roomId);
      game.addPlayer(socket.id, name, null, phone);
      
      if (game.gameState !== 'PLAYING') {
        game.startGame();
      }

      io.to(roomId).emit('room_state_update', game.getSnapshot());
    } catch (err) {
      console.error('Error join_room:', err.message);
    }
  });

  // Memilih Jalur Strategi
  socket.on('select_path', (data) => {
    try {
      const roomId = socket.roomId;
      if (!roomId) return;
      const game = activeGames.get(roomId);
      if (game) {
        game.setPlayerPath(socket.id, data?.path);
        io.to(roomId).emit('room_state_update', game.getSnapshot());
      }
    } catch (err) {
      console.error('Error select_path:', err.message);
    }
  });

  // Memutar Roda / Dadu
  socket.on('req_spin_wheel', async () => {
    try {
      const roomId = socket.roomId;
      if (!roomId) return;
      const game = activeGames.get(roomId);
      if (!game) return;

      const result = await game.spinLuckyWheel(socket.id);
      if (result.success) {
        io.to(roomId).emit('wheel_spun', result);
        io.to(roomId).emit('room_state_update', game.getSnapshot());
      } else {
        socket.emit('error_msg', result.reason);
      }
    } catch (err) {
      console.error('Error req_spin_wheel:', err.message);
    }
  });

  // Menjawab Kuis
  socket.on('submit_quiz_answer', (data) => {
    try {
      const roomId = socket.roomId;
      if (!roomId) return;
      const game = activeGames.get(roomId);
      if (!game) return;

      const result = game.answerQuiz(socket.id, data?.selectedIndex);
      if (result.success) {
        io.to(roomId).emit('quiz_result', result);
        io.to(roomId).emit('room_state_update', game.getSnapshot());
      }
    } catch (err) {
      console.error('Error submit_quiz_answer:', err.message);
    }
  });

  // Membeli Item Sabotase
  socket.on('buy_sabotage', (data) => {
    try {
      const roomId = socket.roomId;
      if (!roomId) return;
      const game = activeGames.get(roomId);
      if (game) {
        game.buyItem(socket.id, data?.itemType, data?.cost);
        io.to(roomId).emit('room_state_update', game.getSnapshot());
      }
    } catch (err) {
      console.error('Error buy_sabotage:', err.message);
    }
  });

  // Mengirimkan Emote
  socket.on('send_taunt', (data) => {
    try {
      const roomId = socket.roomId;
      if (!roomId) return;
      const game = activeGames.get(roomId);
      if (game) {
        const tauntRes = game.triggerTaunt(socket.id, data?.emoteId);
        if (tauntRes?.success) {
          io.to(roomId).emit('taunt_received', tauntRes);
        }
      }
    } catch (err) {
      console.error('Error send_taunt:', err.message);
    }
  });

  // Putus Koneksi
  socket.on('disconnect', () => {
    try {
      console.log('❌ Player keluar:', socket.id);
      const roomId = socket.roomId;
      if (roomId && activeGames.has(roomId)) {
        const game = activeGames.get(roomId);
        game.removePlayer(socket.id);

        if (game.players.size === 0) {
          game.stopTimer();
          activeGames.delete(roomId);
        } else {
          io.to(roomId).emit('room_state_update', game.getSnapshot());
        }
      }
    } catch (err) {
      console.error('Error disconnect:', err.message);
    }
  });
});

// 6. MIDTRANS PAYMENT GATEWAY
app.post('/api/payment/charge', async (req, res) => {
  try {
    const { amount, phone } = req.body;
    if (!amount || !phone) {
      return res.status(400).json({ success: false, message: 'Data pembayaran tidak lengkap' });
    }

    const snap = new midtransClient.Snap({
      isProduction: false,
      serverKey: process.env.MIDTRANS_SERVER_KEY || 'SB-Mid-server-DEMO_KEY'
    });

    const parameter = {
      transaction_details: {
        order_id: 'DIAMOND-' + Date.now(),
        gross_amount: Number(amount)
      },
      customer_details: {
        phone: String(phone)
      }
    };

    const transaction = await snap.createTransaction(parameter);
    res.json({ success: true, token: transaction.token });
  } catch (error) {
    console.error('Midtrans Error:', error.message);
    res.status(500).json({ success: false, message: 'Gagal memproses pembayaran' });
  }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`🚀 Server berjalan stabil di Port ${PORT}`);
  console.log(`=================================`);
});
