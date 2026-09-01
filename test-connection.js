require('dotenv').config();
const { fetchFromDevice, configuredDevices } = require('./src/device');

async function testDevice(device) {
  const tag = device.label ? `${device.label} (${device.ip})` : device.ip;
  console.log(`[test] trying to reach ${tag}...`);
  try {
    const { users, logs } = await fetchFromDevice(device);
    console.log(`[test] ${tag}: connected successfully!`);
    console.log(`[test] ${tag}: users on device = ${users ? users.data.length : 'unknown'}`);
    console.log(`[test] ${tag}: attendance records on device = ${logs.length}`);
    if (logs.length) {
      console.log(`[test] ${tag}: sample record =`, logs[0]);
    }
    return true;
  } catch (err) {
    console.error(`[test] ${tag}: FAILED - ${err.message}`);
    return false;
  }
}

async function main() {
  const devices = configuredDevices();
  if (!devices.length) {
    console.error('[test] No device configured - set DEVICE_IN_IP/DEVICE_OUT_IP (or DEVICE_IP) in .env');
    process.exit(1);
  }

  let allOk = true;
  for (const device of devices) {
    const ok = await testDevice(device);
    allOk = allOk && ok;
  }

  if (!allOk) {
    console.error('\n[test] checklist for failed device(s):');
    console.error('  1. Is the IP in .env correct? (check device menu: Comm/Ethernet settings)');
    console.error('  2. Is the device on the same wifi/LAN as this machine? (ping the IP)');
    console.error('  3. Is the device port actually 4370? (check device Comm settings)');
    console.error('  4. Does the device have a communication password set? (node-zklib assumes none/default)');
    process.exit(1);
  }
}

main();
