const ZKLib = require('node-zklib');

async function fetchFromDevice({ ip, port } = {}) {
  const deviceIp = ip || process.env.DEVICE_IP;
  const devicePort = Number(port || process.env.DEVICE_PORT || 4370);

  const zk = new ZKLib(
    deviceIp,
    devicePort,
    Number(process.env.DEVICE_TIMEOUT || 10000),
    Number(process.env.DEVICE_INPORT || 5200)
  );

  // the library's connect handshake uses a hardcoded 2s timeout (ignores our config),
  // which can be too tight over wifi - retry a few times before giving up
  const maxAttempts = 4;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await zk.createSocket();
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      console.error(`[device] connect attempt ${attempt}/${maxAttempts} to ${deviceIp}:${devicePort} failed:`, err.err ? err.err.message : err.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (lastErr) {
    throw new Error(`Could not reach device at ${deviceIp}:${devicePort} after ${maxAttempts} attempts - ${lastErr.err ? lastErr.err.message : lastErr.message}`);
  }

  try {
    const [users, attendance] = await Promise.all([
      zk.getUsers().catch(() => null),
      zk.getAttendances(),
    ]);
    return { users, logs: attendance.data || [] };
  } finally {
    await zk.disconnect();
  }
}

// returns [{ label: 'IN', ip, port }, { label: 'OUT', ip, port }] from env,
// skipping any side that isn't configured (so single-device setups still work)
function configuredDevices() {
  const port = process.env.DEVICE_PORT || 4370;
  const devices = [];
  if (process.env.DEVICE_IN_IP) devices.push({ label: 'IN', ip: process.env.DEVICE_IN_IP, port });
  if (process.env.DEVICE_OUT_IP) devices.push({ label: 'OUT', ip: process.env.DEVICE_OUT_IP, port });
  if (!devices.length && process.env.DEVICE_IP) devices.push({ label: null, ip: process.env.DEVICE_IP, port });
  return devices;
}

module.exports = { fetchFromDevice, configuredDevices };
