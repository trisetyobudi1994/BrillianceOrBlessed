require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const midtransClient = require('midtrans-client');
const mongoose = require('mongoose');

const app = express();
// [PERBAIKAN PENTING]: CORS Origin "*" wajib agar aplikasi dari APK (localhost/file) diizinkan masuk
app.use(cors({ origin: "*" }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// ==========================================
// MONGODB SETUP (Opsional: Jika Mongo URI kosong, server tetap jalan)
// ==========================================
if (process.env.MONGO_URI) {
    mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
        .then(() => console.log('✅ MongoDB Connected'))
        .catch(err => console.error('❌ MongoDB Connection Error:', err));
} else {
    console.warn('⚠️ MONGO_URI tidak ditemukan, kuis akan menggunakan data cadangan.');
}

// ==========================================
// GAME STATE MANAGEMENT
// ==========================================
const rooms = {};

// Fungsi pembantu untuk membuang properti internal seperti timerInterval sebelum dikirim ke Socket.io
function getCleanRoomData(room) {
    if (!room) return null;
    return {
        id: room.id,
        players: room.players,
        currentTurn: room.currentTurn,
        timeRemaining: room.timeRemaining,
        arenaReady: room.arenaReady,
        gameState: room.gameState
    };
}

// Fungsi untuk memindahkan giliran ke pemain selanjutnya
function nextTurn(roomId) {
    const room = rooms[roomId];
    if (!room || room.players.length === 0) return;

    let currentIndex = room.players.findIndex(p => p.id === room.currentTurn);
    let nextIndex = (currentIndex + 1) % room.players.length;

    room.currentTurn = room.players[nextIndex].id;
    room.timeRemaining = 30; // Reset waktu menjadi 30 detik

    // Broadcast update state bersih ke semua pemain di ruangan
    io.to(roomId).emit("room_state_update", getCleanRoomData(room));
}

// Sistem Timer Real-time (Berjalan setiap 1 detik)
function startRoomTimer(roomId) {
    if (rooms[roomId].timerInterval) clearInterval(rooms[roomId].timerInterval);
    
    rooms[roomId].timerInterval = setInterval(() => {
        const room = rooms[roomId];
        if (!room) return;

        room.timeRemaining -= 1;
        
        if (room.timeRemaining <= 0) {
            // Waktu habis, pindah giliran otomatis
            nextTurn(roomId);
        } else {
            // Update waktu ke UI menggunakan data bersih
            io.to(roomId).emit("room_state_update", getCleanRoomData(room));
        }
    }, 1000);
}

// ==========================================
// SOCKET.IO EVENT HANDLERS
// ==========================================
io.on("connection", (socket) => {
    console.log("⚡ Player terhubung:", socket.id);

    // Pemain Bergabung ke Arena
    socket.on("join_game", (data) => {
        const { roomId, name, phone } = data;
        socket.join(roomId);

        // Buat room baru jika belum ada
        if (!rooms[roomId]) {
            rooms[roomId] = {
                id: roomId,
                players: [],
                currentTurn: socket.id, // Giliran pertama diberikan ke pembuat room
                timeRemaining: 30,
                arenaReady: true,       // WAJIB: Agar teks INITIALIZING hilang di Frontend
                gameState: 'PLAYING',   // WAJIB
                timerInterval: null
            };
            startRoomTimer(roomId);
        }

        // Tambahkan pemain ke dalam room
        const playerExists = rooms[roomId].players.find(p => p.id === socket.id);
        if (!playerExists) {
            rooms[roomId].players.push({
                id: socket.id,
                name: name || "Hero",
                phone: phone,
                position: 0,
                gold: 0,
                isFrozen: false
            });
        }

        // Kirim update state bersih ke Frontend untuk mengubah UI
        io.to(roomId).emit("room_state_update", getCleanRoomData(rooms[roomId]));
    });

    // Fitur Taunting Emoji
    socket.on("send_taunt", (data) => {
        const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
        if (roomId && rooms[roomId]) {
            const player = rooms[roomId].players.find(p => p.id === socket.id);
            io.to(roomId).emit("taunt_received", { senderName: player?.name || "Unknown", emoteId: data.emoteId });
        }
    });

    // Fitur Spin Wheel & Kuis
    socket.on("req_spin_wheel", () => {
        const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
        if (roomId && rooms[roomId]) {
            // Jika bukan gilirannya, blokir
            if (rooms[roomId].currentTurn !== socket.id) return; 

            const slotIndex = Math.floor(Math.random() * 6);
            const triggerQuiz = (slotIndex === 0 || slotIndex === 3); // Kuis acak

            io.to(roomId).emit("wheel_spun", {
                slotIndex,
                triggerQuiz,
                quizPrompt: triggerQuiz ? {
                    question: "Esport manakah yang paling populer di Asia Tenggara?",
                    options: ["Dota 2", "Mobile Legends", "Valorant", "PUBG"],
                    answer: 1
                } : null
            });

            // Tunda perpindahan giliran agar animasi Spin/Kuis selesai
            setTimeout(() => {
                nextTurn(roomId);
            }, 6000);
        }
    });

    // Pemain Keluar/Putus Koneksi
    socket.on("disconnect", () => {
        console.log("❌ Player keluar:", socket.id);
        for (const roomId in rooms) {
            const room = rooms[roomId];
            room.players = room.players.filter(p => p.id !== socket.id);
            
            // Jika room kosong, matikan timer dan hapus room
            if (room.players.length === 0) {
                clearInterval(room.timerInterval);
                delete rooms[roomId];
            } else if (room.currentTurn === socket.id) {
                // Jika pemain yang disconnect sedang giliran, pindah ke pemain lain
                nextTurn(roomId);
            } else {
                io.to(roomId).emit("room_state_update", getCleanRoomData(room));
            }
        }
    });
});

// ==========================================
// PAYMENT GATEWAY API (MIDTRANS)
// ==========================================
app.post('/api/payment/charge', async (req, res) => {
    try {
        const { amount, phone, goldAmount } = req.body;
        
        // Inisialisasi Midtrans Snap
        let snap = new midtransClient.Snap({
            isProduction: false,
            // Masukkan Server Key Anda di Environment Variable Railway
            serverKey: process.env.MIDTRANS_SERVER_KEY || 'SB-Mid-server-DEMO_KEY'
        });

        let parameter = {
            transaction_details: {
                order_id: "DIAMOND-" + Date.now(),
                gross_amount: amount
            },
            customer_details: {
                phone: phone
            }
        };
        
        const transaction = await snap.createTransaction(parameter);
        res.json({ success: true, token: transaction.token });
    } catch (error) {
        console.error("Midtrans Error:", error);
        res.status(500).json({ success: false, message: 'Gagal membuat transaksi' });
    }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`🚀 Server berjalan di PORT ${PORT}`);
    console.log(`=================================`);
});
