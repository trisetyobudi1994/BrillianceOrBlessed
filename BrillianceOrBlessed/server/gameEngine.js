const Quiz = require('./models/Quiz');

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
    this.players = new Map();
    this.playerOrder = [];
    this.currentTurnIndex = 0;
    this.boardSize = 20;
    this.gameState = 'PLAYING';
    this.arenaReady = true;
    this.turnTimer = null;
    this.turnDuration = 30;
    this.timeRemaining = 30;
    this.activeQuiz = null;
    this.onTick = null; // Callback broadcast
  }

  addPlayer(socketId, name, avatar, phone) {
    if (this.players.size >= 4) return false;
    if (!this.players.has(socketId)) {
      this.players.set(socketId, {
        id: socketId,
        name: name || `Hero ${this.players.size + 1}`,
        phone: phone || '',
        avatar: avatar || 'default_avatar.png',
        position: 0,
        gold: 1000,
        path: null,
        isFrozen: false,
        inventory: ['SWAP', 'FREEZE'],
        tauntCooldown: 0
      });
      this.playerOrder.push(socketId);
    }
    return true;
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    this.playerOrder = this.playerOrder.filter(id => id !== socketId);
    if (this.players.size === 0) {
      this.stopTimer();
    } else {
      this.currentTurnIndex = this.currentTurnIndex % this.playerOrder.length;
    }
  }

  setPlayerPath(socketId, path) {
    const player = this.players.get(socketId);
    if (player) {
      player.path = path;
    }
  }

  buyItem(socketId, itemType, cost) {
    const player = this.players.get(socketId);
    if (player && player.gold >= cost) {
      player.gold -= cost;
      player.inventory.push(itemType);
      return true;
    }
    return false;
  }

  startGame() {
    if (this.players.size < 1) return false;
    this.gameState = 'PLAYING';
    this.arenaReady = true;
    this.currentTurnIndex = 0;
    this.startTurnTimer();
    return true;
  }

  getCurrentPlayerId() {
    return this.playerOrder[this.currentTurnIndex] || null;
  }

  startTurnTimer() {
    this.stopTimer();
    this.timeRemaining = this.turnDuration;
    
    const currId = this.getCurrentPlayerId();
    const player = currId ? this.players.get(currId) : null;
    if (player && player.isFrozen) {
      player.isFrozen = false;
      this.nextTurn();
      return;
    }

    this.turnTimer = setInterval(() => {
      this.timeRemaining -= 1;
      if (typeof this.onTick === 'function') {
        this.onTick();
      }
      if (this.timeRemaining <= 0) {
        this.nextTurn();
      }
    }, 1000);
  }

  stopTimer() {
    if (this.turnTimer) {
      clearInterval(this.turnTimer);
      this.turnTimer = null;
    }
  }

  nextTurn() {
    this.activeQuiz = null;
    if (this.playerOrder.length > 0) {
      this.currentTurnIndex = (this.currentTurnIndex + 1) % this.playerOrder.length;
      this.startTurnTimer();
    }
  }

  async fetchRandomQuiz() {
    try {
      if (Quiz && Quiz.countDocuments) {
        const count = await Quiz.countDocuments();
        if (count > 0) {
          const random = Math.floor(Math.random() * count);
          return await Quiz.findOne().skip(random);
        }
      }
    } catch (err) {
      console.error('Database quiz fallback activated:', err.message);
    }
    
    return {
      _id: 'fallback_' + Date.now(),
      question: 'Esport manakah yang paling populer di Asia Tenggara?',
      options: ['Dota 2', 'Mobile Legends', 'Valorant', 'PUBG Mobile'],
      correctIndex: 1,
      rewardGold: 500,
      penaltySteps: 2
    };
  }

  async spinLuckyWheel(socketId) {
    if (socketId !== this.getCurrentPlayerId()) {
      return { success: false, reason: 'Bukan giliranmu!' };
    }

    const randomIndex = Math.floor(Math.random() * LUCKY_PATH_SLOTS.length);
    const resultSlot = LUCKY_PATH_SLOTS[randomIndex];
    const player = this.players.get(socketId);

    if (!player) return { success: false, reason: 'Pemain tidak ditemukan' };

    if (resultSlot.type === 'GOLD') player.gold += resultSlot.val;
    if (resultSlot.type === 'JACKPOT') player.gold += resultSlot.val;
    if (resultSlot.type === 'MULTIPLIER') player.gold *= resultSlot.val;
    if (resultSlot.type === 'SABOTAGE') player.inventory.push(resultSlot.val);

    const steps = Math.floor(Math.random() * 6) + 1;
    player.position = Math.min(this.boardSize - 1, player.position + steps);

    const isWinner = player.position >= this.boardSize - 1;
    let quizData = null;

    if (!isWinner && (player.position % 3 === 0) && player.position > 0) {
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
        options: quizData.options
      } : null
    };
  }

  answerQuiz(socketId, selectedIndex) {
    if (!this.activeQuiz || this.activeQuiz.playerId !== socketId) {
      return { success: false, reason: 'Tidak ada kuis aktif!' };
    }

    const player = this.players.get(socketId);
    const isCorrect = selectedIndex === this.activeQuiz.correctIndex;
    let message = '';

    if (isCorrect) {
      player.gold += this.activeQuiz.rewardGold;
      message = `Benar! +${this.activeQuiz.rewardGold} Gold!`;
    } else {
      player.position = Math.max(0, player.position - this.activeQuiz.penaltySteps);
      message = `Salah! Mundur ${this.activeQuiz.penaltySteps} langkah!`;
    }

    this.nextTurn();

    return {
      success: true,
      isCorrect: isCorrect,
      message: message,
      newGold: player.gold,
      newPosition: player.position
    };
  }

  triggerTaunt(socketId, emoteId) {
    const player = this.players.get(socketId);
    if (!player) return null;

    const now = Date.now();
    if (player.tauntCooldown && now < player.tauntCooldown) {
      return { success: false, reason: 'Cooldown taunt' };
    }

    player.tauntCooldown = now + 3000;
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
      arenaReady: this.arenaReady,
      gameState: this.gameState,
      currentTurn: this.getCurrentPlayerId(),
      timeRemaining: this.timeRemaining,
      players: Array.from(this.players.values())
    };
  }
}

module.exports = GameEngine;
