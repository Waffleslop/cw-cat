// DX Cluster telnet client — for spot submission from CW CAT
const net = require('net');
const { EventEmitter } = require('events');

const DEFAULT_HOST = 'w3lpl.net';
const DEFAULT_PORT = 7373;

class DxClusterClient extends EventEmitter {
  constructor() {
    super();
    this._socket = null;
    this._buf = '';
    this._reconnectTimer = null;
    this._keepaliveTimer = null;
    this._target = null;
    this._loggedIn = false;
    this.connected = false;
  }

  connect({ host, port, callsign }) {
    this.disconnect();
    this._target = { host: host || DEFAULT_HOST, port: port || DEFAULT_PORT, callsign: callsign || '' };
    this._loggedIn = false;

    const sock = new net.Socket();
    this._socket = sock;

    sock.on('data', (chunk) => this._onData(chunk));

    sock.on('connect', () => {
      this.connected = true;
      this.emit('status', { connected: true, host: this._target.host, port: this._target.port });
    });

    sock.on('error', () => { /* handled in close */ });

    sock.on('close', () => {
      this.connected = false;
      this._loggedIn = false;
      this._stopKeepalive();
      this.emit('status', { connected: false, host: this._target.host, port: this._target.port });
      this._scheduleReconnect();
    });

    sock.connect(this._target.port, this._target.host);
  }

  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._stopKeepalive();
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    this._buf = '';
    this._loggedIn = false;
    this.connected = false;
  }

  _onData(chunk) {
    this._buf += chunk.toString();
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl).replace(/\r$/, '');
      this._buf = this._buf.slice(nl + 1);
      this._processLine(line);
    }
    if (!this._loggedIn) {
      this._handleLogin(this._buf);
    }
  }

  _processLine(line) {
    if (!this._loggedIn) {
      this._handleLogin(line);
      return;
    }
    if (line.trim()) {
      this.emit('message', line);
    }
  }

  _handleLogin(line) {
    const lower = line.toLowerCase();
    if (lower.includes('login:') || lower.includes('call:') || lower.includes('callsign:') ||
        lower.includes('please enter your call') || />\s*$/.test(line)) {
      if (this._target.callsign && !this._loggedIn) {
        this._write(this._target.callsign + '\r\n');
        this._loggedIn = true;
        this._buf = '';
        this._startKeepalive();
      }
    } else if (lower.includes('password:')) {
      if (this._target.callsign) {
        this._write(this._target.callsign + '\r\n');
      }
    }
  }

  sendSpot({ frequency, callsign, comment }) {
    if (!this.connected || !this._loggedIn) return false;
    this._write(`DX ${parseFloat(frequency).toFixed(1)} ${callsign} ${comment || ''}\r\n`);
    return true;
  }

  _write(data) {
    if (this._socket && this.connected) {
      this._socket.write(data);
    }
  }

  _startKeepalive() {
    this._stopKeepalive();
    this._keepaliveTimer = setInterval(() => {
      this._write('\r\n');
    }, 5 * 60 * 1000);
  }

  _stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || !this._target) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._target) this.connect(this._target);
    }, 10000);
  }
}

module.exports = { DxClusterClient, DEFAULT_HOST, DEFAULT_PORT };
