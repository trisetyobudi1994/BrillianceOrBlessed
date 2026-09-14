// Database Soal (Server-Authoritative)
const QUESTIONS = [
    { id: 1, category: 'LOGIC', q: 'Jika 3 kucing bisa menangkap 3 tikus dalam 3 menit, berapa menit yang dibutuhkan 100 kucing untuk menangkap 100 tikus?', a: ['3 menit', '100 menit', '300 menit', '1 menit'], correct: 0 },
    { id: 2, category: 'MATH', q: 'Berapakah hasil dari 8 + 8 / 4 * 2 - 1?', a: ['11', '7', '15', '3'], correct: 0 },
    { id: 3, category: 'GENERAL', q: 'Planet manakah yang dikenal sebagai Planet Merah?', a: ['Mars', 'Venus', 'Jupiter', 'Saturnus'], correct: 0 },
    { id: 4, category: 'SPEED', q: 'Manakah warna primer berikut ini?', a: ['Biru', 'Hijau', 'Jingga', 'Ungu'], correct: 0 },
    { id: 5, category: 'MEMORY', q: 'Apa elemen pertama dalam tabel periodik?', a: ['Hidrogen', 'Helium', 'Oksigen', 'Karbon'], correct: 0 }
];

class Room {
    constructor(code, hostId, hostName, hostAvatar) {
        this.code = code;
        this.hostId = hostId;
        this.players = {}; // socketId -> playerData
        this.status = 'LOBBY'; // LOBBY, PLAYING, ENDED
        this.currentRound = 0;
        this.maxRounds = 5;
        this.mode = 'smart'; // smart / lucky
        this.currentQuestion = null;
        this.roundTimer = null;
        this.timeLeft = 10;
        
        this.addPlayer(hostId, hostName, hostAvatar, true);
    }

    addPlayer(id, name, avatar, isHost = false) {
        if (Object.keys(this.players).length >= 8) return false;
        this.players[id] = {
            id,
            name: name || 'Pemain',
            avatar: avatar || '🧠',
            score: 0,
            isReady: isHost,
            isHost,
            sabotageReceived: 0,
            hasAnswered: false,
            effects: [] // active sabotage effects
        };
        return true;
    }

    removePlayer(id) {
        delete this.players[id];
        // Assign new host if host leaves
        const pIds = Object.keys(this.players);
        if (pIds.length > 0 && !Object.values(this.players).some(p => p.isHost)) {
            this.players[pIds[0]].isHost = true;
            this.players[pIds[0]].isReady = true;
            this.hostId = pIds[0];
        }
    }

    toggleReady(id) {
        if (this.players[id] && !this.players[id].isHost) {
            this.players[id].isReady = !this.players[id].isReady;
        }
    }

    canStart() {
        const playerList = Object.values(this.players);
        return playerList.length >= 1 && playerList.every(p => p.isReady);
    }

    getLeaderboard() {
        return Object.values(this.players)
            .map(p => ({
                id: p.id,
                name: p.name,
                avatar: p.avatar,
                score: p.score,
                isReady: p.isReady,
                isHost: p.isHost,
                sabotageReceived: p.sabotageReceived
            }))
            .sort((a, b) => b.score - a.score);
    }

    nextRound() {
        this.currentRound++;
        if (this.currentRound > this.maxRounds) {
            this.status = 'ENDED';
            return null;
        }

        // Reset state ronde per pemain
        Object.values(this.players).forEach(p => {
            p.hasAnswered = false;
            p.effects = [];
        });

        this.timeLeft = 10;
        this.currentQuestion = QUESTIONS[(this.currentRound - 1) % QUESTIONS.length];
        return this.currentQuestion;
    }

    submitAnswer(playerId, answerIndex, timeRemaining) {
        const player = this.players[playerId];
        if (!player || player.hasAnswered || this.status !== 'PLAYING') return 0;

        player.hasAnswered = true;
        let gained = 0;

        if (answerIndex === this.currentQuestion.correct) {
            // Kalkulasi skor berbasis waktu + bonus
            gained = 100 + (timeRemaining * 10);
            
            // Pengaruh Sabotage GLITCH (-50% Poin)
            if (player.effects.includes('GLITCH')) {
                gained = Math.floor(gained * 0.5);
            }
            player.score += gained;
        }

        return gained;
    }

    applySabotage(attackerId, targetId, type) {
        const target = this.players[targetId];
        const attacker = this.players[attackerId];

        if (!target || !attacker) return { success: false, reason: 'Pemain tidak ditemukan' };
        if (target.sabotageReceived >= 3) {
            return { success: false, reason: 'Pemain ini sudah mencapai batas 3x sabotase!' };
        }

        target.sabotageReceived++;
        target.effects.push(type);

        if (type === 'SHUFFLE') {
            target.score = Math.max(0, target.score - 50);
        }

        return { 
            success: true, 
            targetName: target.name, 
            attackerName: attacker.name, 
            type 
        };
    }
}

module.exports = { Room, QUESTIONS };