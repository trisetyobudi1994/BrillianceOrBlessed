const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Setup Socket.io dengan CORS terbuka
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json());

// Melayani file statis dari folder client
app.use(express.static(path.join(__dirname, '../client')));

// Data penyimpanan room & player di memory
const rooms = {};

// Handle Koneksi Socket.io
io.on('connection', (socket) => {
  console.log(`[+] Player Terhubung: ${socket.id}`);

  // Fungsi untuk memasukkan player ke dalam room & memulai game
  const handleJoin = (data = {}) => {
    const roomId = data.roomId || 'default-room';
    const name = data.name || 'Hero';
    const phone = data.phone || '-';
    const mode = data.mode || 'classic';

    // Simpan roomId di instance socket agar mudah diakses di event lain
    socket.roomId = roomId;
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        roomId: roomId,
        arenaReady: true, // Flag utama untuk melepas indikator "INITIALIZING ARENA"
        gameState: 'PLAYING',
        currentTurn: socket.id,
        timeRemaining: 30,
        players: []
      };
    } else {
      rooms[roomId].arenaReady = true;
    }

    // Cek jika player belum ada di daftar room
    let player = rooms[roomId].players.find(p => p.id === socket.id);
    if (!player) {
      player = {
        id: socket.id,
        name: name,
        phone: phone,
        position: 0,
        gold: 1000,
        isFrozen: false
      };
      rooms[roomId].players.push(player);
    }

    console.log(`[+] ${name} (${socket.id}) bergabung ke room: ${roomId} [Mode: ${mode}]`);

    // Kirim pembaruan state arena ke semua pemain di room ini
    io.to(roomId).emit('room_state_update', rooms[roomId]);
    io.to(roomId).emit('updateGameState', rooms[roomId]);
  };

  // 1. Tangkap event join
  socket.on('join_room', handleJoin);
  socket.on('join_game', handleJoin);

  // 2. Event Spin Wheel
  socket.on('req_spin_wheel', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    const slotIndex = Math.floor(Math.random() * 6);
    const triggerQuiz = slotIndex === 1 || slotIndex === 4;

    const quizPrompt = triggerQuiz ? {
      question: "Apa role utama Hero Tigreal di Mobile Legends?",
      imageUrl: "https://images.unsplash.com/photo-1579783902614-a3fb3927b675?w=400",
      options: ["Tank", "Mage", "Assassin", "Marksman"]
    } : null;

    // Broadcast khusus ke room terkait
    io.to(roomId).emit('wheel_spun', { slotIndex, triggerQuiz, quizPrompt, playerId: socket.id });
  });

  // 3. Event Kirim Emote / Taunt
  socket.on('send_taunt', (data = {}) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    const sender = rooms[roomId].players.find(p => p.id === socket.id);

    io.to(roomId).emit('taunt_received', {
      senderId: socket.id,
      senderName: sender ? sender.name : 'Hero',
      emoteId: data.emoteId
    });
  });

  // 4. Event Jawab Kuis
  socket.on('submit_quiz_answer', (data = {}) => {
    const roomId = socket.roomId;
    const isCorrect = data.selectedIndex === 0; // Jawaban benar: Tank (indeks 0)

    if (roomId && rooms[roomId]) {
      const player = rooms[roomId].players.find(p => p.id === socket.id);
      if (player && isCorrect) {
        player.gold += 100;
        // Sync state terbaru ke client
        io.to(roomId).emit('room_state_update', rooms[roomId]);
        io.to(roomId).emit('updateGameState', rooms[roomId]);
      }
    }

    socket.emit('quiz_result', {
      success: isCorrect,
      message: isCorrect ? 'Jawaban Benar! +100 Gold 💎' : 'Jawaban Salah!'
    });
  });

  // 5. Event Sabotase (Swap / Freeze)
  socket.on('req_use_sabotage', (data = {}) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    const { itemId, targetId } = data;
    const room = rooms[roomId];

    if (itemId === 'freeze' && targetId) {
      const targetPlayer = room.players.find(p => p.id === targetId);
      if (targetPlayer) targetPlayer.isFrozen = true;
    }

    io.to(roomId).emit('sabotage_executed', {
      executorId: socket.id,
      itemId: itemId,
      effectSummary: `Efek ${itemId || 'sabotase'} berhasil diterapkan!`
    });

    io.to(roomId).emit('room_state_update', room);
    io.to(roomId).emit('updateGameState', room);
  });

  // 6. Handle Disconnect
  socket.on('disconnect', () => {
    console.log(`[-] Player Terputus: ${socket.id}`);
    const roomId = socket.roomId;

    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      room.players = room.players.filter(p => p.id !== socket.id);

      if (room.players.length === 0) {
        delete rooms[roomId];
      } else {
        // Jika player yang disconnect sedang memegang giliran, oper giliran ke pemain pertama yang tersisa
        if (room.currentTurn === socket.id) {
          room.currentTurn = room.players[0].id;
        }

        io.to(roomId).emit('room_state_update', room);
        io.to(roomId).emit('updateGameState', room);
      }
    }
  });
});

// Endpoint Dummy Payment Midtrans
app.post('/api/payment/charge', (req, res) => {
  res.json({
    success: true,
    token: "dummy-snap-token-123456"
  });
});

// Fallback Route untuk melayani file index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`Server running on port ${PORT}`);
  console.log(`=================================`);
});
