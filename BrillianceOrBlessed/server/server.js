// server/server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const GameEngine = require('./gameEngine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, '../client')));

const rooms = new Map(); // roomId -> GameEngine

io.on('connection', (socket) => {
  console.log(`[Connect] Socket terhubung: ${socket.id}`);

  // 1. Join / Create Room Realtime
  socket.on('join_room', ({ roomId, name, avatar }) => {
    let room = rooms.get(roomId);
    if (!room) {
      room = new GameEngine(roomId);
      rooms.set(roomId, room);
    }

    const joined = room.addPlayer(socket.id, name, avatar);
    if (!joined) {
      socket.emit('error_msg', 'Room sudah penuh!');
      return;
    }

    socket.join(roomId);
    socket.roomId = roomId;

    // Siarkan pembaruan state ke seluruh klien di room
    io.to(roomId).emit('room_state_update', room.getSnapshot());
  });

  // 2. Start Game Sync
  socket.on('start_game', () => {
    const room = rooms.get(socket.roomId);
    if (room && room.startGame()) {
      io.to(socket.roomId).emit('game_started', room.getSnapshot());
    }
  });

  // 3. Spin Wheel Realtime Sync
  socket.on('req_spin_wheel', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;

    const spinResult = room.spinLuckyWheel(socket.id);
    if (spinResult.success) {
      // Disiarkan ke seluruh pemain untuk animasi berbarengan
      io.to(socket.roomId).emit('wheel_spun', {
        playerId: socket.id,
        ...spinResult,
        gameState: room.getSnapshot()
      });
    } else {
      socket.emit('error_msg', spinResult.reason);
    }
  });

  // 4. Sabotase Realtime
  socket.on('use_sabotage', ({ targetId, itemId }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;

    const result = room.useSabotage(socket.id, targetId, itemId);
    if (result.success) {
      io.to(socket.roomId).emit('sabotage_executed', {
        ...result,
        gameState: room.getSnapshot()
      });
    } else {
      socket.emit('error_msg', result.reason);
    }
  });

  // 5. Taunt & Emote Sync
  socket.on('send_taunt', ({ emoteId }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;

    const tauntRes = room.triggerTaunt(socket.id, emoteId);
    if (tauntRes.success) {
      io.to(socket.roomId).emit('taunt_received', tauntRes);
    }
  });

  // Disconnect & Cleanup
  socket.on('disconnect', () => {
    console.log(`[Disconnect] Socket terputus: ${socket.id}`);
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        room.removePlayer(socket.id);
        if (room.players.size === 0) {
          rooms.delete(socket.roomId);
        } else {
          io.to(socket.roomId).emit('room_state_update', room.getSnapshot());
        }
      }
    }
  });
});

// Periodic Sync Interval (State Authoritative Engine Check)
setInterval(() => {
  rooms.forEach((room, roomId) => {
    if (room.gameState === 'PLAYING') {
      io.to(roomId).emit('timer_tick', {
        timeRemaining: room.timeRemaining,
        currentTurn: room.getCurrentPlayerId()
      });
    }
  });
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[Server] Berjalan di port ${PORT}`));
