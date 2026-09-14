const Quiz = require('./models/Quiz');

const SABOTAGE_ITEMS = {
  SWAP: { id: 'SWAP', name: 'Tukar Posisi', sfx: 'swap_whoosh' },
  FREEZE: { id: 'FREEZE', name: 'Pembekuan (Skip Turn)', sfx: 'freeze_ice' },
  TRAP: { id: 'TRAP', name: 'Jebakan Lumpur (-3 Langkah)', sfx: 'trap_splat' },
  STEAL: { id: 'STEAL', name: 'Curi Poin (50% Gold)', sfx: 'steal_coins' }
};

const LUCKY_PATH_SLOTS = [
  { type: 'MULTIPLIER', val: 2, label: '2x Gold', color: '#f39c12' },
  { type: 'JACKPOT', val: 1000, label: 'JACKPOT!', color: '#e74c3c' },
  { type: 'SABOTAGE', val: 'SWAP', label: 'Item Swap', color: '#9b59b6' },
  { type: 'GOLD', val: 100, label: '+100 Gold', color: '#f1c40f' },
  { type: 'NEAR_MISS', val: 0, label: 'Zonk!', color: '#7f8c8d' },
  { type: 'SABOTAGE', val: 'FREEZE', label: 'Item Freeze', color: '#3498db' }
];

class GameEngine {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = new Map(); // socketId -> playerData
    this.playerOrder = [];
    this.currentTurnIndex = 0;
    this.boardSize = 30;
    this.gameState = 'WAITING'; // WAITING, PLAYING, FINISHED
    this.turnTimer = null;
    this.turnDuration = 15; // 15 detik per giliran
    this.timeRemaining = 15;
    
    // Status Kuis Aktif
    this.activeQuiz = null; // Menyimpan kuis yang sedang berlangsung
  }

  addPlayer(socketId, name, avatar) {
    if (this.players.size >= 4) return false;
    this.players.set(socketId, {
      id: socketId,
      name: name || `Pemain ${this.players.size + 1}`,
      avatar: avatar || 'default_avatar.png',
      position: 0,
      gold: 500,
      isFrozen: false,
      inventory: ['SWAP', 'FREEZE'],
      tauntCooldown: 0
    });
    this.playerOrder.push(socketId);
    return true;
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    this.playerOrder = this.playerOrder.filter(id => id !== socketId);
    if (this.players.size === 0) {
      this.stopTimer();
    }
  }

  startGame() {
    if (this.players.size < 2) return false;
    this.gameState = 'PLAYING';
    this.currentTurnIndex = 0;
    this.startTurnTimer();
    return true;
  }

  getCurrentPlayerId() {
    return this.playerOrder[this.currentTurnIndex];
  }

  startTurnTimer() {
    this.stopTimer();
    this.timeRemaining = this.turnDuration;
    
    // Cek status pembekuan giliran
    const currId = this.getCurrentPlayerId();
    const player = this.players.get(currId);
    if (player && player.isFrozen) {
      player.isFrozen = false;
      this.nextTurn();
      return;
    }

    this.turnTimer = setInterval(() => {
      this.timeRemaining -= 1;
      if (this.timeRemaining <= 0) {
        this.nextTurn();
      }
    }, 1000);
  }

  stopTimer() {
    if (this.turnTimer) clearInterval(this.turnTimer);
  }

  nextTurn() {
    this.activeQuiz = null; // Reset status kuis saat ganti giliran
    this.currentTurnIndex = (this.currentTurnIndex + 1) % this.playerOrder.length;
    this.startTurnTimer();
  }

  // Mengambil Kuis Acak dari MongoDB Database
  async fetchRandomQuiz() {
    try {
      const count = await Quiz.countDocuments();
      if (count === 0) {
        // Fallback jika database kuis masih kosong
        return {
          _id: 'fallback_1',
          question: 'Tebak objek pada gambar di bawah ini!',
          imageUrl: 'https://images.unsplash.com/photo-1579783902614-a3fb3927b675?w=400',
          options: ['Lukisan', 'Patung', 'Candi', 'Monumen'],
          correctIndex: 0,
          rewardGold: 500,
          penaltySteps: 2
        };
      }
      const random = Math.floor(Math.random() * count);
      return await Quiz.findOne().skip(random);
    } catch (err) {
      console.error('Gagal mengambil kuis dari database:', err);
      return null;
    }
  }

  // Spin Lucky Path / Roda Kemenangan
  async spinLuckyWheel(socketId) {
    if (socketId !== this.getCurrentPlayerId()) return { success: false, reason: 'Bukan giliranmu!' };

    // Kalkulasi Acak Server Side
    const randomIndex = Math.floor(Math.random() * LUCKY_PATH_SLOTS.length);
    const resultSlot = LUCKY_PATH_SLOTS[randomIndex];
    const player = this.players.get(socketId);

    // Proses efek reward
    if (resultSlot.type === 'GOLD') player.gold += resultSlot.val;
    if (resultSlot.type === 'JACKPOT') player.gold += resultSlot.val;
    if (resultSlot.type === 'MULTIPLIER') player.gold *= resultSlot.val;
    if (resultSlot.type === 'SABOTAGE') player.inventory.push(resultSlot.val);

    // Langkah otomatis berdasarkan spin
    const steps = Math.floor(Math.random() * 6) + 1;
    player.position = Math.min(this.boardSize, player.position + steps);

    const isWinner = player.position >= this.boardSize;
    let quizData = null;

    // Cek apakah pemain mendarat di Petak Kuis (misal: Kelipatan 5)
    if (!isWinner && player.position % 5 === 0 && player.position > 0) {
      quizData = await this.fetchRandomQuiz();
      if (quizData) {
        this.activeQuiz = {
          quizId: quizData._id,
          correctIndex: quizData.correctIndex,
          rewardGold: quizData.rewardGold || 500,
          penaltySteps: quizData.penaltySteps || 2,
          playerId: socketId
        };
      }
    }

    if (isWinner) {
      this.gameState = 'FINISHED';
      this.stopTimer();
    } else if (!quizData) {
      // Jika tidak mendarat di petak kuis, ganti giliran seperti biasa
      this.nextTurn();
    }

    return {
      success: true,
      slotIndex: randomIndex,
      slotResult: resultSlot,
      steps: steps,
      newPosition: player.position,
      isWinner: isWinner,
      triggerQuiz: !!quizData,
      quizPrompt: quizData ? {
        question: quizData.question,
        imageUrl: quizData.imageUrl,
        options: quizData.options
      } : null
    };
  }

  // Verifikasi Jawaban Kuis yang Dikirim Pemain
  answerQuiz(socketId, selectedIndex) {
    if (!this.activeQuiz || this.activeQuiz.playerId !== socketId) {
      return { success: false, reason: 'Tidak ada kuis aktif untukmu!' };
    }

    const player = this.players.get(socketId);
    const isCorrect = selectedIndex === this.activeQuiz.correctIndex;
    let message = '';

    if (isCorrect) {
      player.gold += this.activeQuiz.rewardGold;
      message = `Benar! ${player.name} mendapatkan +${this.activeQuiz.rewardGold} Gold!`;
    } else {
      player.position = Math.max(0, player.position - this.activeQuiz.penaltySteps);
      message = `Salah! ${player.name} mundur ${this.activeQuiz.penaltySteps} langkah!`;
    }

    // Selesaikan kuis dan lanjut ke giliran berikutnya
    this.nextTurn();

    return {
      success: true,
      isCorrect: isCorrect,
      message: message,
      newGold: player.gold,
      newPosition: player.position
    };
  }

  // Menjalankan Aksi Sabotase terhadap Pemain Lain
  useSabotage(attackerId, targetId, itemId) {
    if (attackerId !== this.getCurrentPlayerId()) return { success: false, reason: 'Bukan giliranmu!' };

    const attacker = this.players.get(attackerId);
    const target = this.players.get(targetId);

    if (!attacker || !target) return { success: false, reason: 'Pemain tidak ditemukan!' };

    const itemIdx = attacker.inventory.indexOf(itemId);
    if (itemIdx === -1) return { success: false, reason: 'Kamu tidak memiliki item ini!' };

    // Hapus item dari inventaris
    attacker.inventory.splice(itemIdx, 1);

    let effectSummary = '';

    switch (itemId) {
      case 'SWAP':
        const tempPos = attacker.position;
        attacker.position = target.position;
        target.position = tempPos;
        effectSummary = `${attacker.name} menukar posisi dengan ${target.name}!`;
        break;

      case 'FREEZE':
        target.isFrozen = true;
        effectSummary = `${target.name} dibekukan untuk 1 giliran berikutnya!`;
        break;

      case 'TRAP':
        target.position = Math.max(0, target.position - 3);
        effectSummary = `${target.name} terkena jebakan lumpur dan mundur 3 langkah!`;
        break;

      case 'STEAL':
        const stolenAmount = Math.floor(target.gold * 0.3);
        target.gold -= stolenAmount;
        attacker.gold += stolenAmount;
        effectSummary = `${attacker.name} mencuri ${stolenAmount} Gold dari ${target.name}!`;
        break;
    }

    return {
      success: true,
      itemId: itemId,
      attackerId: attackerId,
      targetId: targetId,
      effectSummary: effectSummary
    };
  }

  // Sistem Taunt & Emote
  triggerTaunt(socketId, emoteId) {
    const player = this.players.get(socketId);
    if (!player) return null;

    const now = Date.now();
    if (player.tauntCooldown && now < player.tauntCooldown) {
      return { success: false, reason: 'Taunt sedang cooldown!' };
    }

    player.tauntCooldown = now + 3000; // Cooldown 3 detik

    return {
      success: true,
      senderId: socketId,
      senderName: player.name,
      emoteId: emoteId
    };
  }

  getSnapshot() {
    return {
      roomId: this.roomId,
      gameState: this.gameState,
      currentTurn: this.getCurrentPlayerId(),
      timeRemaining: this.timeRemaining,
      players: Array.from(this.players.values())
    };
  }
}

module.exports = GameEngine;
