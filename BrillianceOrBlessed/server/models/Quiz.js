const mongoose = require('mongoose');

const QuizSchema = new mongoose.Schema({
  question: { type: String, required: true },
  imageUrl: { type: String, required: true },
  options: [{ type: String, required: true }],
  correctIndex: { type: Number, required: true },
  rewardGold: { type: Number, default: 500 },
  penaltySteps: { type: Number, default: 2 },
  category: { type: String, default: 'General' }
});

module.exports = mongoose.model('Quiz', QuizSchema);
