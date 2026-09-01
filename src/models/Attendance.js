const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  deviceUserId: { type: String, required: true },
  recordTime: { type: Date, required: true },
  deviceIp: { type: String },
  punchType: { type: String, enum: ['IN', 'OUT', null], default: null },
  raw: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

// prevents the same punch from being inserted twice across repeated syncs
attendanceSchema.index({ deviceUserId: 1, recordTime: 1, punchType: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', attendanceSchema);
