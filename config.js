// Optional settings for online play.
// Most players connect fine with the defaults. If friends on strict mobile/corporate
// networks can't join, add a TURN server here (e.g. from metered.ca, Twilio or Cloudflare):
//
// iceServers: [{ urls: 'turn:YOUR_TURN_HOST:443', username: 'USER', credential: 'PASS' }]
//
// peerHost lets you use your own PeerJS signaling server instead of the free public one.
window.FELT_CONFIG = {
  iceServers: [],
  peerHost: null,
};
