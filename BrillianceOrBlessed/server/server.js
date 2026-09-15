const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static('client'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Database Sementara (In-Memory)
const rooms = {};
const userBalances = {}; // phone -> gold

/* 1. MIDTRANS WEBHOOK NOTIFICATION ROUTE (SERVER-SIDE VERIFICATION) */
app.post('/api/payment/notification', (req, res) => {
  const notification = req.body;
  const serverKey = process.env.MIDTRANS_SERVER_KEY || 'SB-Mid-server-YOUR_SERVER_KEY';

  // Verifikasi Signature Key Midtrans
  const signatureInput = notification.order_id + notification.status_code + notification.gross_amount + serverKey;
  const expectedSignature = crypto.createHash('sha512').update(signatureInput).digest('hex');

  if (notification.signature_key !== expectedSignature) {
    return res.status(403).json({ message: 'Signature tidak valid' });
  }

  const transactionStatus = notification.transaction_status;
  const fraudStatus = notification.fraud_status;

  if (transactionStatus === 'capture' || transactionStatus === 'settlement') {
    if (fraudStatus === 'challenge') {
      // Pembayaran mencurigakan
    } else if (fraudStatus === 'accept' || !fraudStatus) {
      // Pembayaran sukses disetujui
      const phone = notification.custom_field1;
      const goldToAdd = parseInt(notification.custom_field2) || 5000;
      
      userBalances[phone] = (userBalances[phone] || 1000) + goldToAdd;
      console.log(`[PAYMENT SUCCESS] Phone: ${phone}, +${goldToAdd} Gold`);
    }
  }

  res.status(200).json({ status: 'OK' });
});

/* 2. GAME ENGINE & SOCKET LOGIC */
const QUIZ_BANK = [
  { question: "Hero manakah yang memiliki role Assassin di MOBA?", options: ["Lancelot", "Tigreal", "Angela", "Gord"], correct: 0 },
  { question: "Apa sebutan untuk mengeliminasi 5 musuh sekaligus?", options: ["Double Kill", "Triple Kill", "Savage / Penta", "Maniac"], correct: 2 },
  { question: "Item apa yang memberikan efek lifesteal fisik?", options: ["HAAS Claw", "Demon Shoes", "Holy Crystal", "Dominance Ice"], correct: 0 }
];

io.on('connection', (socket) => {
  socket.on('join_room', ({ roomId, phone, name, mode }) => {
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
        name,
        position: 0,
        gold: userBalances[phone] || 1000,
        path: null,
        isFrozen: false
      };
      room.players.push(player);
    } else {
      player.id = socket.id; // Update socket id jika reconnect
    }

    if (mode === 'solo' && room.players.length === 1) {
      // Tambahkan BOT untuk Solo Mode
      room.players.push({
        id: 'bot_ai',
        phone: '000000',
        name: 'AI Training Bot',
        position: 0,
        gold: 1000,
        path: 'PINTAR',
        isFrozen: false
      });
    }

    startRoomTimer(roomId);
    broadcastRoomState(roomId);
  });

  socket.on('select_path', ({ path }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.path = path;
    broadcastRoomState(socket.roomId);
  });

  socket.on('req_spin_wheel', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const player = room.players[room.currentTurnIndex];
    if (!player || player.id !== socket.id) return; // Anti-Cheat: Hanya pemain gilirannya yang bisa spin

    const steps = Math.floor(Math.random() * 6) + 1;
    player.position = Math.min(19, player.position + steps);

    const triggerQuiz = (player.position % 2 === 0); // Kotak genap = Kuis
    let quizPrompt = null;

    if (triggerQuiz) {
      quizPrompt = QUIZ_BANK[Math.floor(Math.random() * QUIZ_BANK.length)];
      room.currentQuiz = { correct: quizPrompt.correct, playerId: player.id };
    }

    io.to(socket.roomId).emit('wheel_spun', { steps, triggerQuiz, quizPrompt });

    // Cek Kemenangan
    if (player.position >= 19) {
      io.to(socket.roomId).emit('game_over', {
        winnerId: player.id,
        winnerName: player.name,
        rankings: [...room.players].sort((a, b) => b.position - a.position)
      });
      clearInterval(room.timer);
      return;
    }

    if (!triggerQuiz) {
      nextTurn(socket.roomId);
    }
  });

  socket.on('submit_quiz_answer', ({ selectedIndex }) => {
    const room = rooms[socket.roomId];
    if (!room || !room.currentQuiz) return;

    const isCorrect = (selectedIndex === room.currentQuiz.correct);
    const player = room.players.find(p => p.id === socket.id);

    if (player) {
      if (isCorrect) player.gold += 300;
      else player.gold = Math.max(0, player.gold - 100);
    }

    socket.emit('quiz_result', {
      isCorrect,
      message: isCorrect ? 'Jawaban Tepat! +300 Diamond' : 'Jawaban Salah! -100 Diamond'
    });

    delete room.currentQuiz;
    nextTurn(socket.roomId);
  });

  socket.on('use_sabotage', ({ itemType, targetId }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const target = room.players.find(p => p.id === targetId);
    if (target && itemType === 'FREEZE') {
      target.isFrozen = true;
      io.to(socket.roomId).emit('error_msg', `${target.name} terkena status FREEZE untuk 1 giliran!`);
      broadcastRoomState(socket.roomId);
    }
  });

  socket.on('send_taunt', ({ emoteId }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    io.to(socket.roomId).emit('taunt_received', { senderName: player ? player.name : 'Pemain', emoteId });
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.roomId];
    if (room) {
      // Gantikan peran pemain yang putus koneksi dengan BOT
      const p = room.players.find(p => p.id === socket.id);
      if (p) p.name += ' (Bot)';
    }
  });
});

function nextTurn(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
  room.timeRemaining = 15;

  const currentP = room.players[room.currentTurnIndex];
  
  // Jika pemain terkena efek Freeze, lewati gilirannya
  if (currentP.isFrozen) {
    currentP.isFrozen = false;
    io.to(roomId).emit('error_msg', `Giliran ${currentP.name} dilewati karena FREEZE!`);
    nextTurn(roomId);
    return;
  }

  // Jika giliran BOT AI
  if (currentP.id === 'bot_ai') {
    setTimeout(() => {
      currentP.position = Math.min(19, currentP.position + Math.floor(Math.random() * 4) + 1);
      nextTurn(roomId);
    }, 1500);
  }

  broadcastRoomState(roomId);
}

function startRoomTimer(roomId) {
  const room = rooms[roomId];
  if (room.timer) return;

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
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
