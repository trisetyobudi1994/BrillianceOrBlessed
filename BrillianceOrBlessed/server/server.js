const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Setup Socket.io dengan CORS agar HP / Client eksternal bisa terhubung
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

// Helper untuk mendapatkan Room ID tempat player berada
const getPlayerRoom = (socket) => {
  return Array.from(socket.rooms).find(r => r !== socket.id);
};

// Handle Koneksi Socket.io
io.on('connection', (socket) => {
  console.log(`[+] Player Terhubung: ${socket.id}`);

  // Fungsi untuk memasukkan player ke dalam room & memulai game
  const handleJoin = (data = {}) => {
    const roomId = data.roomId || 'default-room';
    const name = data.name || 'Hero';
    const phone = data.phone || '-';
    const mode = data.mode || 'classic';

    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        roomId: roomId,
        arenaReady: true, // FIXED: Properti utama agar tampilan stuck INITIALIZING ARENA di client terbuka
        gameState: 'PLAYING',
        currentTurn: socket.id,
        timeRemaining: 30,
        players: []
      };
    } else {
      rooms[roomId].arenaReady = true;
    }

    // Cek jika player belum ada di daftar
    const existingPlayer = rooms[roomId].players.find(p => p.id === socket.id);
    if (!existingPlayer) {
      rooms[roomId].players.push({
        id: socket.id,
        name: name,
        phone: phone,
        position: 0,
        gold: 1000,
        isFrozen: false
      });
    }

    console.log(`[+] ${name} bergabung ke room: ${roomId} (${mode})`);

    // Kirim pembaruan state arena ke semua pemain di room ini
    io.to(roomId).emit('room_state_update', rooms[roomId]);
    io.to(roomId).emit('updateGameState', rooms[roomId]); // FIXED: Memastikan kompatibilitas jika client memakai listener ini
  };

  // 1. Tangkap event join dari client
  socket.on('join_room', handleJoin);
  socket.on('join_game', handleJoin);

  // 2. Event Spin Wheel (Putar Roda)
  socket.on('req_spin_wheel', () => {
    const playerRoom = getPlayerRoom(socket);
    const slotIndex = Math.floor(Math.random() * 6);
    const triggerQuiz = slotIndex === 1 || slotIndex === 4; // Contoh kondisi kuis

    const quizPrompt = triggerQuiz ? {
      question: "Apa role utama Hero Tigreal di Mobile Legends?",
      imageUrl: "https://images.unsplash.com/photo-1579783902614-a3fb3927b675?w=400",
      options: ["Tank", "Mage", "Assassin", "Marksman"]
    } : null;

    // Send payload ke room terkait saja
    const target = playerRoom ? io.to(playerRoom) : io;
    target.emit('wheel_spun', { slotIndex, triggerQuiz, quizPrompt });
  });

  // 3. Event Kirim Emote / Taunt
  socket.on('send_taunt', (data) => {
    const playerRoom = getPlayerRoom(socket);
    const sender = rooms[playerRoom]?.players.find(p => p.id === socket.id);
    
    io.to(playerRoom || socket.id).emit('taunt_received', {
      senderName: sender ? sender.name : 'Hero',
      emoteId: data.emoteId
    });
  });

  // 4. Event Jawab Kuis
  socket.on('submit_quiz_answer', (data) => {
    const isCorrect = data.selectedIndex === 0; // Jawaban benar: Tank (indeks 0)
    socket.emit('quiz_result', {
      success: isCorrect,
      message: isCorrect ? 'Jawaban Benar! +100 Diamond 💎' : 'Jawaban Salah!'
    });
  });

  // 5. Event Sabotase (Swap / Freeze)
  socket.on('req_use_sabotage', (data) => {
    const playerRoom = getPlayerRoom(socket);
    const { itemId } = data;
    
    const target = playerRoom ? io.to(playerRoom) : io;
    target.emit('sabotage_executed', {
      effectSummary: `Efek ${itemId} berhasil diterapkan ke lawan!`
    });
  });

  // 6. Handle Disconnect
  socket.on('disconnect', () => {
    console.log(`[-] Player Terputus: ${socket.id}`);
    for (const roomId in rooms) {
      rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
      if (rooms[roomId].players.length === 0) {
        delete rooms[roomId];
      } else {
        io.to(roomId).emit('room_state_update', rooms[roomId]);
        io.to(roomId).emit('updateGameState', rooms[roomId]);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`Server running on port ${PORT}`);
  console.log(`=================================`);
});
