const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
// 1. Perbaikan: Sesuaikan dengan nama file gameEngine.js
const gameManager = require('./gameEngine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Menyajikan file statis dari folder client
app.use(express.static(path.join(__dirname, '../client')));

io.on('connection', (socket) => {
    console.log(`🔌 Player connected: ${socket.id}`);

    // Create Room
    socket.on('createRoom', (playerData) => {
        const room = gameManager.createRoom(socket.id, playerData);
        socket.join(room.code);
        socket.emit('roomCreated', { roomCode: room.code, room });
    });

    // Join Room
    socket.on('joinRoom', ({ code, playerData }) => {
        const roomCode = code.toUpperCase();
        const result = gameManager.joinRoom(roomCode, socket.id, playerData);
        
        if (result.error) {
            socket.emit('errorMsg', result.error);
        } else {
            socket.join(roomCode);
            io.to(roomCode).emit('roomUpdated', { room: result.room });
        }
    });

    // Toggle Ready State
    socket.on('toggleReady', ({ code }) => {
        const room = gameManager.toggleReady(socket.id, code);
        if (room) {
            io.to(code).emit('roomUpdated', { room });
        }
    });

    // Start Game
    socket.on('startGame', ({ code }) => {
        const room = gameManager.rooms.get(code);
        if (room && room.hostId === socket.id) {
            room.state = 'PLAYING';
            io.to(code).emit('gameStarted');
            gameManager.startRound(code, io);
        }
    });

    // Answer Question
    socket.on('submitAnswer', ({ code, answerIndex }) => {
        gameManager.submitAnswer(code, socket.id, answerIndex, io);
    });

    // Sabotage Player
    socket.on('useSabotage', ({ code, targetId, type }) => {
        const result = gameManager.applySabotage(code, socket.id, targetId, type, io);
        if (result.error) {
            socket.emit('errorMsg', result.error);
        }
    });

    // Disconnect Handling
    socket.on('disconnect', () => {
        console.log(`❌ Player disconnected: ${socket.id}`);
        const result = gameManager.leaveRoom(socket.id);
        if (result && result.room) {
            io.to(result.code).emit('roomUpdated', { room: result.room });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server Brilliance or Blessed 3.0 berjalan di port ${PORT}`);
});
