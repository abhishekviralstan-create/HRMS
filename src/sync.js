const { fetchFromDevice, configuredDevices } = require('./device');
const Attendance = require('./models/Attendance');

const syncStatus = {
  running: false,
  lastStartedAt: null,
  lastCompletedAt: null,
  lastError: null,
  devices: {},
};

async function syncDevice(device) {
  const tag = device.label ? `${device.label} (${device.ip})` : device.ip;
  console.log(`[sync] pulling from ${tag}...`);
  const { users, logs } = await fetchFromDevice(device);

  const operations = logs.map((log) => {
    const recordTime = new Date(log.recordTime);
    const rawUserId = String(log.deviceUserId ?? log.userSid ?? log.uid);
    const deviceUserId = /^\d{1,8}$/.test(rawUserId) ? rawUserId.padStart(8, '0') : rawUserId;
    return {
      updateOne: {
        filter: { deviceUserId, recordTime, punchType: device.label || null },
        update: {
          $setOnInsert: {
            deviceUserId,
            recordTime,
            deviceIp: device.ip,
            punchType: device.label || null,
            raw: log,
          },
        },
        upsert: true,
      },
    };
  });

  const result = operations.length
    ? await Attendance.bulkWrite(operations, { ordered: false })
    : { upsertedCount: 0 };
  const inserted = result.upsertedCount || 0;

  syncStatus.devices[device.ip] = {
    label: device.label || null,
    online: true,
    recordsReceived: logs.length,
    usersReceived: users ? users.data.length : null,
    newRecords: inserted,
    checkedAt: new Date(),
    error: null,
  };
  console.log(`[sync] ${tag}: inserted ${inserted} new record(s), skipped ${logs.length - inserted} duplicate(s)`);
  return inserted;
}

async function syncOnce() {
  if (syncStatus.running) return 0;
  const devices = configuredDevices();
  if (!devices.length) {
    throw new Error('No device configured - set DEVICE_IN_IP/DEVICE_OUT_IP or DEVICE_IP in .env');
  }

  syncStatus.running = true;
  syncStatus.lastStartedAt = new Date();
  let total = 0;
  const errors = [];
  try {
    for (const device of devices) {
      try {
        total += await syncDevice(device);
      } catch (error) {
        errors.push(`${device.ip}: ${error.message}`);
        syncStatus.devices[device.ip] = {
          label: device.label || null,
          online: false,
          checkedAt: new Date(),
          error: error.message,
        };
      }
    }
    syncStatus.lastCompletedAt = new Date();
    syncStatus.lastError = errors.length ? errors.join('; ') : null;
    if (errors.length === devices.length) throw new Error(syncStatus.lastError);
    return total;
  } finally {
    syncStatus.running = false;
  }
}

module.exports = { syncDevice, syncOnce, syncStatus };
