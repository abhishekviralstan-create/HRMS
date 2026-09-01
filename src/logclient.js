const net = require('net');
const Attendance = require('./models/Attendance');
const { syncStatus } = require('./sync');

function value(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? match[1].trim() : null;
}

function parseTimeLog(xml, remoteIp) {
  if (value(xml, 'Event') !== 'TimeLog') return null;
  const parts = ['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second'].map((tag) => Number(value(xml, tag)));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  const recordTime = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  const deviceIp = remoteIp.replace(/^::ffff:/, '');
  const attendStatus = value(xml, 'AttendStat');
  const normalizedStatus = (attendStatus || '').toLowerCase();
  let punchType = normalizedStatus.includes('off') || normalizedStatus.includes('out') ? 'OUT' : 'IN';
  if (process.env.DEVICE_IN_IP && deviceIp === process.env.DEVICE_IN_IP) punchType = 'IN';
  if (process.env.DEVICE_OUT_IP && deviceIp === process.env.DEVICE_OUT_IP) punchType = 'OUT';
  return {
    deviceUserId: /^\d{1,8}$/.test(value(xml, 'UserID') || '') ? value(xml, 'UserID').padStart(8, '0') : value(xml, 'UserID'),
    recordTime,
    deviceIp,
    punchType,
    raw: {
      event: 'TimeLog',
      attendStatus,
      verificationMode: value(xml, 'VerifMode'),
      terminalType: value(xml, 'TerminalType'),
      terminalId: value(xml, 'TerminalID'),
      deviceUid: value(xml, 'DeviceUID'),
      deviceSerialNo: value(xml, 'DeviceSerialNo'),
      transactionId: value(xml, 'TransID'),
      jobCode: value(xml, 'JobCode'),
      photo: value(xml, 'Photo'),
    },
  };
}

function startLogClientServer(port = 5005) {
  const server = net.createServer((socket) => {
    console.log(`[logclient] device connected: ${socket.remoteAddress}`);
    let pending = '';
    socket.on('data', async (data) => {
      pending += data.toString('utf8').replace(/\0/g, '');
      let end;
      while ((end = pending.indexOf('</Message>')) !== -1) {
        const xml = pending.slice(0, end + 10);
        pending = pending.slice(end + 10);
        try {
          const record = parseTimeLog(xml, socket.remoteAddress);
          if (!record || !record.deviceUserId) continue;
          // ack immediately rather than waiting on the DB write first.
          socket.write('OK');
          console.log(`[punch] ${record.punchType} user=${record.deviceUserId} time=${record.recordTime.toLocaleString('en-IN')}`);
          Attendance.updateOne(
            { deviceUserId: record.deviceUserId, recordTime: record.recordTime, punchType: record.punchType },
            { $setOnInsert: record },
            { upsert: true }
          ).catch((error) => console.error('[logclient] could not save packet:', error.message));
          syncStatus.lastCompletedAt = new Date();
          syncStatus.lastError = null;
          syncStatus.devices[record.deviceIp] = {
            label: record.punchType,
            online: true,
            checkedAt: new Date(),
            recordsReceived: 1,
            error: null,
          };
        } catch (error) {
          console.error('[logclient] could not save packet:', error.message);
        }
      }
    });
    socket.on('error', (error) => console.error('[logclient] socket:', error.message));
  });
  server.on('error', (error) => console.error(`[logclient] port ${port}:`, error.message));
  server.listen(port, '0.0.0.0', () => console.log(`[logclient] listening on TCP ${port}`));
  return server;
}

module.exports = { parseTimeLog, startLogClientServer };
