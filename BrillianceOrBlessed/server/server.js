const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.json());
app.use(express.static('client'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// DATABASE PEMAIN TERSIMPAN DI SERVER (Key: Phone Number)
const playersDB = {}; 
const rooms = {};
let paymentSettings = {
  bank: 'Bank BCA',
  num: '8830-1234-5678 a.n Arena Esports',
  qris: ''
};

const QUIZ_BANK = [
  { question: "Hero apakah yang bertipe Assassin?", options: ["Lancelot", "Tigreal", "Angela", "Gord"], correct: 0 },
  { question: "Apa sebutan untuk 5 kill beruntun?", options: ["Double Kill", "Savage", "Maniac", "Triple Kill"], correct: 1 }
];

io.on('connection', (socket) => {
  
  // 1. PENDAFTARAN PEMAIN BARU
  socket.on('player_register', ({ name, phone, color }) => {
    if (playersDB[phone]) {
      socket.emit('error_msg', 'Nomor HP sudah terdaftar. Silakan lakukan Login!');
      return;
    }

    const newPlayer = {
      phone,
      name,
      color: color || '#ff6b00',
      gold: 1000
    };

    playersDB[phone] = newPlayer;
    socket.emit('register_success', newPlayer);
  });

  // 2. LOGIN PEMAIN TERDAFTAR
  socket.on('player_login', ({ phone }) => {
    if (!playersDB[phone]) {
      socket.emit('error_msg', 'Nomor HP belum terdaftar. Silakan daftar dulu!');
      return;
    }

    socket.emit('login_success', playersDB[phone]);
  });

  // 3. JOIN ROOM GAMEPLAY
  socket.on('join_room', ({ roomId, phone, mode }) => {
    const playerProfile = playersDB[phone];
    if (!playerProfile) {
      socket.emit('error_msg', 'Sesi tidak valid, silakan login kembali.');
      return;
    }

    socket.join(roomId);
    socket.roomId = roomId;

    if (!rooms[roomId]) {
      rooms[roomId] = {
        id: roomId,
        players: [],
        currentTurnIndex: 0,
        timeRemaining: 15,
        timer: null
      };
    }

    const room = rooms[roomId];
    let player = room.players.find(p => p.phone === phone);

    if (!player) {
      player = {
        id: socket.id,
        phone,
        name: playerProfile.name,
        color: playerProfile.color,
        position: 0,
        gold: playerProfile.gold,
        path: null
      };
      room.players.push(player);
    } else {
      player.id = socket.id;
    }

    if (mode === 'solo' && room.players.length === 1) {
      room.players.push({
        id: 'bot_ai',
        phone: '0000',
        name: 'AI Training Bot',
        color: '#2563eb',
        position: 0,
        gold: 1000,
        path: 'PINTAR'
      });
    }

    startRoomTimer(roomId);
    broadcastRoomState(roomId);
  });

  socket.on('select_path', ({ path }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const p = room.players.find(player => player.id === socket.id);
    if (p) p.path = path;
    broadcastRoomState(socket.roomId);
  });

  socket.on('req_spin_wheel', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const p = room.players[room.currentTurnIndex];
    if (!p || p.id !== socket.id) return;

    const steps = Math.floor(Math.random() * 6) + 1;
    p.position = Math.min(19, p.position + steps);

    const triggerQuiz = (p.position % 2 === 0);
    let quizPrompt = null;

    if (triggerQuiz) {
      quizPrompt = QUIZ_BANK[Math.floor(Math.random() * QUIZ_BANK.length)];
      room.currentQuiz = { correct: quizPrompt.correct, playerId: p.id };
    }

    io.to(socket.roomId).emit('wheel_spun', { steps, triggerQuiz, quizPrompt });

    if (!triggerQuiz) {
      nextTurn(socket.roomId);
    }
  });

  socket.on('submit_quiz_answer', ({ selectedIndex }) => {
    const room = rooms[socket.roomId];
    if (!room || !room.currentQuiz) return;

    const isCorrect = (selectedIndex === room.currentQuiz.correct);
    const p = room.players.find(player => player.id === socket.id);

    if (p && isCorrect) p.gold += 300;

    delete room.currentQuiz;
    nextTurn(socket.roomId);
  });

  // 4. OTENTIKASI & AKSES ADMIN
  socket.on('admin_login', ({ pass }) => {
    if (pass === 'admin123') { // Passcode default Admin
      socket.emit('admin_login_success', {
        players: Object.values(playersDB)
      });
    } else {
      socket.emit('error_msg', 'Kode Akses Admin Salah!');
    }
  });

  socket.on('admin_save_payment', ({ bank, num, qris }) => {
    paymentSettings = { bank, num, qris };
    socket.emit('error_msg', 'Pengaturan Pembayaran Berhasil Disimpan!');
  });

  socket.on('get_payment_settings', () => {
    socket.emit('payment_settings_data', paymentSettings);
  });

  socket.on('admin_add_gold', ({ phone, amount }) => {
    if (playersDB[phone]) {
      playersDB[phone].gold += amount;
      socket.emit('admin_login_success', { players: Object.values(playersDB) });
    }
  });
});

function nextTurn(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
  room.timeRemaining = 15;

  const currentP = room.players[room.currentTurnIndex];
  if (currentP && currentP.id === 'bot_ai') {
    setTimeout(() => {
      currentP.position = Math.min(19, currentP.position + Math.floor(Math.random() * 4) + 1);
      nextTurn(roomId);
    }, 1200);
  }

  broadcastRoomState(roomId);
}

function startRoomTimer(roomId) {
  const room = rooms[roomId];
  if (!room || room.timer) return;

  room.timer = setInterval(() => {
    room.timeRemaining--;
    if (room.timeRemaining <= 0) {
      nextTurn(roomId);
    } else {
      broadcastRoomState(roomId);
    }
  }, 1000);
}

function broadcastRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('room_state_update', {
    players: room.players,
    currentTurn: room.players[room.currentTurnIndex]?.id,
    timeRemaining: room.timeRemaining
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server aktif di port ${PORT}`));
