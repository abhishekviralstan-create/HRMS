require('dotenv').config();
const net = require('net');

const port = Number(process.env.HOST_PC_PORT || 5005);

const server = net.createServer((socket) => {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[device] connected: ${remote}`);

  socket.on('data', (data) => {
    const readable = data.toString('utf8').replace(/[^\x20-\x7e\r\n\t]/g, '.');
    console.log(`[data] ${new Date().toISOString()} ${data.length} byte(s)`);
    console.log(`[text] ${readable}`);
    console.log(`[hex]  ${data.toString('hex')}`);
  });

  socket.on('end', () => console.log(`[device] disconnected: ${remote}`));
  socket.on('error', (error) => console.error(`[device] ${remote}: ${error.message}`));
});

server.on('error', (error) => {
  console.error(`[listener] failed on port ${port}: ${error.message}`);
  process.exit(1);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[listener] waiting for Secureye LogClient data on TCP port ${port}`);
  console.log('[listener] ab OUT machine par ek punch karein; Ctrl+C se band karein');
});
