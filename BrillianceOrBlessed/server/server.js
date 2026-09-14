const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const GameEngine = require('./gameEngine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

// Koneksi Database
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/brilliance_game';
mongoose.connect(MONGO_URI)
  .then(() => console.log('⚡ Connected to MongoDB'))
  .catch(err => console.error('MongoDB Error:', err));

const gameRooms = new Map();

function getOrCreateRoom(roomId) {
  if (!gameRooms.has(roomId)) {
    gameRooms.set(roomId, new GameEngine(roomId));
  }
  return gameRooms.get(roomId);
}

io.on('connection', (socket) => {
  console.log(`🎮 Player Connected: ${socket.id}`);

  socket.on('join_room', ({ roomId, name }) => {
    const room = getOrCreateRoom(roomId);
    socket.join(roomId);
    socket.roomId = roomId;

    const added = room.addPlayer(socket.id, name || `Hero_${socket.id.slice(0, 4)}`);
    if (!added) return socket.emit('error_message', 'Room penuh!');

    if (room.players.size >= 2 && room.gameState === 'WAITING') {
      room.startGame();
    }

    io.to(roomId).emit('room_state_update', room.getSnapshot());
  });

  socket.on('req_spin_wheel', async () => {
    const room = gameRooms.get(socket.roomId);
    if (!room) return;

    const result = await room.spinLuckyWheel(socket.id);
    if (result.success) {
      io.to(socket.roomId).emit('wheel_spun', result);
      io.to(socket.roomId).emit('room_state_update', room.getSnapshot());

      if (result.isWinner) {
        io.to(socket.roomId).emit('game_finished', { winnerId: socket.id });
      }
    } else {
      socket.emit('error_message', result.reason);
    }
  });

  socket.on('submit_quiz_answer', ({ selectedIndex }) => {
    const room = gameRooms.get(socket.roomId);
    if (!room) return;

    const quizRes = room.answerQuiz(socket.id, selectedIndex);
    socket.emit('quiz_result', quizRes);
    io.to(socket.roomId).emit('room_state_update', room.getSnapshot());
  });

  socket.on('req_use_sabotage', ({ targetId, itemId }) => {
    const room = gameRooms.get(socket.roomId);
    if (!room) return;

    const sabRes = room.useSabotage(socket.id, targetId, itemId);
    if (sabRes.success) {
      io.to(socket.roomId).emit('sabotage_executed', sabRes);
      io.to(socket.roomId).emit('room_state_update', room.getSnapshot());
    } else {
      socket.emit('error_message', sabRes.reason);
    }
  });

  socket.on('send_taunt', ({ emoteId }) => {
    const room = gameRooms.get(socket.roomId);
    if (!room) return;

    const tauntRes = room.triggerTaunt(socket.id, emoteId);
    if (tauntRes && tauntRes.success) {
      io.to(socket.roomId).emit('taunt_received', tauntRes);
    }
  });

  socket.on('disconnect', () => {
    const room = gameRooms.get(socket.roomId);
    if (room) {
      room.removePlayer(socket.id);
      io.to(socket.roomId).emit('room_state_update', room.getSnapshot());
    }
  });
});

app.post('/api/payment/charge', (req, res) => {
  res.json({ success: true, token: 'SNAP_TOKEN_DUMMY', message: 'Charge success' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server berjalan di http://localhost:${PORT}`));
