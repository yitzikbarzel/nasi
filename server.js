const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SUITS = ['♠', '♥', '♦', '♣'];
const ROOM_IDLE_LIMIT_MS = 2 * 60 * 60 * 1000;
const DISCONNECT_GRACE_MS = 60 * 1000;
const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;

const rooms = {};
const disconnectTimers = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[code]);
  return code;
}

function createDeck() {
  const deck = [];
  for (let r = 0; r < RANKS.length; r++) {
    for (const suit of SUITS) {
      deck.push({ rank: RANKS[r], suit, value: r });
    }
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function recordAction(room, action) {
  room.actionCounter = (room.actionCounter || 0) + 1;
  room.lastAction = { id: room.actionCounter, ...action };
}

function sanitizeRoom(room, forPlayerId) {
  return {
    id: room.id,
    creatorId: room.creatorId,
    state: room.state,
    currentPlayerIndex: room.currentPlayerIndex,
    pile: room.pile,
    pileCount: room.pileCount,
    pileMinValue: room.pileMinValue,
    consecutivePasses: room.consecutivePasses,
    activePlayers: room.activePlayers,
    lastPlayerId: room.lastPlayerId,
    lastAction: room.lastAction || null,
    mushiMode: !!room.mushiMode,
    players: room.players.map(p => {
      const hideForOther = p.hideCount && p.id !== forPlayerId;
      return {
        id: p.id,
        name: p.name,
        passed: p.passed,
        connected: p.connected,
        finishRank: p.finishRank,
        hideCount: !!p.hideCount,
        cardCount: hideForOther ? null : p.hand.length,
        hand: p.id === forPlayerId ? p.hand : { cardCount: hideForOther ? null : p.hand.length }
      };
    })
  };
}

function broadcastRoomUpdate(room) {
  room.lastActivity = Date.now();
  for (const p of room.players) {
    if (p.connected) {
      io.to(p.id).emit('room_update', sanitizeRoom(room, p.id));
    }
  }
}

function broadcastGameOver(room) {
  const rankings = [...room.players]
    .filter(p => p.finishRank !== null)
    .sort((a, b) => a.finishRank - b.finishRank)
    .map(p => ({ name: p.name, place: p.finishRank }));
  for (const p of room.players) {
    if (p.connected) io.to(p.id).emit('game_over', { rankings });
  }
}

function dealCards(room) {
  const deck = shuffle(createDeck());
  const n = room.players.length;
  const handCount = (room.mushiMode && n === 2) ? 3 : n;
  for (const p of room.players) p.hand = [];
  for (let i = 0; i < deck.length; i++) {
    const target = i % handCount;
    if (target < n) {
      room.players[target].hand.push(deck[i]);
    }
  }
  for (const p of room.players) {
    p.hand.sort((a, b) => a.value - b.value || a.suit.localeCompare(b.suit));
  }
}

function startGame(room) {
  room.state = 'playing';
  for (const p of room.players) {
    p.passed = false;
    p.finishRank = null;
  }
  dealCards(room);
  room.pile = [];
  room.pileCount = 0;
  room.pileMinValue = -1;
  room.consecutivePasses = 0;
  room.activePlayers = room.players.length;
  room.lastPlayerId = null;
  room.topFinishers = 0;
  room.bottomFinishers = 0;
  room.lastAction = null;
  room.actionCounter = 0;

  let firstIdx = 0;
  let lowestVal = Infinity;
  for (let i = 0; i < room.players.length; i++) {
    const minCard = Math.min(...room.players[i].hand.map(c => c.value));
    if (minCard < lowestVal) {
      lowestVal = minCard;
      firstIdx = i;
    }
  }
  room.currentPlayerIndex = firstIdx;
  recordAction(room, { type: 'start', playerName: room.players[firstIdx].name });
}

function findNextActivePlayer(room, fromIdx) {
  let idx = fromIdx;
  for (let i = 0; i < room.players.length; i++) {
    idx = (idx + 1) % room.players.length;
    const p = room.players[idx];
    if (p.finishRank === null) return idx;
  }
  return fromIdx;
}

function checkAutoAdvance(room) {
  if (room.state !== 'playing') return;
  const cur = room.players[room.currentPlayerIndex];
  if (cur && !cur.connected && cur.finishRank === null) {
    setTimeout(() => {
      const room2 = rooms[room.id];
      if (!room2 || room2.state !== 'playing') return;
      const cur2 = room2.players[room2.currentPlayerIndex];
      if (!cur2 || cur2.connected || cur2.finishRank !== null) return;
      const result = doPass(room2, cur2.id, true);
      if (result.ok) {
        broadcastRoomUpdate(room2);
        checkAutoAdvance(room2);
      }
    }, 1000);
  }
}

function doPlayCards(room, playerId, cards) {
  const playerIdx = room.players.findIndex(p => p.id === playerId);
  if (playerIdx === -1) return { error: 'השחקן לא בחדר' };
  if (room.state !== 'playing') return { error: 'המשחק לא בעיצומו' };
  if (playerIdx !== room.currentPlayerIndex) return { error: 'לא תורך' };
  const player = room.players[playerIdx];
  if (player.finishRank !== null) return { error: 'כבר סיימת' };
  if (!Array.isArray(cards) || cards.length === 0) return { error: 'לא נבחרו קלפים' };

  const handCopy = player.hand.map(c => ({ ...c }));
  for (const c of cards) {
    const idx = handCopy.findIndex(hc => hc.rank === c.rank && hc.suit === c.suit);
    if (idx === -1) return { error: 'הקלף לא ביד שלך' };
    handCopy.splice(idx, 1);
  }

  const firstRank = cards[0].rank;
  if (!cards.every(c => c.rank === firstRank)) {
    return { error: 'כל הקלפים חייבים להיות באותה דרגה' };
  }

  if (room.pileCount > 0 && cards.length !== room.pileCount) {
    return { error: `חובה לשחק ${room.pileCount} קלפים` };
  }

  const minVal = Math.min(...cards.map(c => c.value));
  if (room.pileCount > 0 && minVal < room.pileMinValue) {
    return { error: 'חובה לשחק דרגה שווה או גבוהה יותר' };
  }

  player.hand = handCopy;
  player.hand.sort((a, b) => a.value - b.value || a.suit.localeCompare(b.suit));
  room.pile = cards.map(c => ({ ...c }));
  room.pileCount = cards.length;
  room.pileMinValue = minVal;
  room.consecutivePasses = 0;
  room.lastPlayerId = player.id;
  for (const p of room.players) p.passed = false;

  recordAction(room, { type: 'play', playerName: player.name, cards: room.pile });

  let gameOver = false;
  if (player.hand.length === 0) {
    room.topFinishers++;
    player.finishRank = room.topFinishers;
    room.activePlayers--;
    recordAction(room, { type: 'finish', playerName: player.name, place: player.finishRank });
  }

  if (room.activePlayers <= 1) {
    for (const p of room.players) {
      if (p.finishRank === null) {
        room.topFinishers++;
        p.finishRank = room.topFinishers;
      }
    }
    room.state = 'finished';
    gameOver = true;
  } else {
    room.currentPlayerIndex = findNextActivePlayer(room, room.currentPlayerIndex);
  }

  return { ok: true, gameOver };
}

function doPass(room, playerId, auto = false) {
  const playerIdx = room.players.findIndex(p => p.id === playerId);
  if (playerIdx === -1) return { error: 'השחקן לא בחדר' };
  if (room.state !== 'playing') return { error: 'המשחק לא בעיצומו' };
  if (playerIdx !== room.currentPlayerIndex) return { error: 'לא תורך' };
  const player = room.players[playerIdx];
  if (player.finishRank !== null) {
    room.currentPlayerIndex = findNextActivePlayer(room, room.currentPlayerIndex);
    return { ok: true };
  }

  if (room.pileCount === 0) {
    if (!auto) return { error: 'אתה חייב לפתוח את הסיבוב — לא ניתן לפסוס על ערימה ריקה' };
    recordAction(room, { type: 'auto-pass', playerName: player.name });
    room.currentPlayerIndex = findNextActivePlayer(room, room.currentPlayerIndex);
    return { ok: true };
  }

  player.passed = true;
  room.consecutivePasses++;
  recordAction(room, { type: auto ? 'auto-pass' : 'pass', playerName: player.name });

  if (room.consecutivePasses >= room.activePlayers - 1) {
    const clearedCount = room.pile.length;
    room.pile = [];
    room.pileCount = 0;
    room.pileMinValue = -1;
    room.consecutivePasses = 0;
    for (const p of room.players) p.passed = false;

    let leadIdx;
    if (room.lastPlayerId) {
      const lastIdx = room.players.findIndex(p => p.id === room.lastPlayerId);
      if (lastIdx !== -1 && room.players[lastIdx].finishRank === null) {
        leadIdx = lastIdx;
      } else {
        leadIdx = findNextActivePlayer(room, room.currentPlayerIndex);
      }
    } else {
      leadIdx = findNextActivePlayer(room, room.currentPlayerIndex);
    }
    room.currentPlayerIndex = leadIdx;
    room.lastPlayerId = null;
    recordAction(room, {
      type: 'clear',
      cardsCleared: clearedCount,
      leadPlayerName: room.players[leadIdx].name
    });
  } else {
    room.currentPlayerIndex = findNextActivePlayer(room, room.currentPlayerIndex);
  }
  return { ok: true };
}

function handlePlayerTimeout(roomId, playerName) {
  const room = rooms[roomId];
  if (!room) return;
  const player = room.players.find(p => p.name === playerName);
  if (!player || player.connected) return;

  if (room.state === 'lobby') {
    room.players = room.players.filter(p => p.id !== player.id);
    if (room.players.length === 0) {
      delete rooms[roomId];
      return;
    }
    if (room.creatorId === player.id) {
      room.creatorId = room.players[0].id;
    }
    broadcastRoomUpdate(room);
    return;
  }

  if (room.state !== 'playing') return;
  if (player.finishRank !== null) return;

  room.bottomFinishers++;
  player.finishRank = room.players.length - room.bottomFinishers + 1;
  room.activePlayers--;
  recordAction(room, { type: 'timeout', playerName: player.name });

  if (room.activePlayers <= 1) {
    for (const p of room.players) {
      if (p.finishRank === null) {
        room.topFinishers++;
        p.finishRank = room.topFinishers;
      }
    }
    room.state = 'finished';
    broadcastRoomUpdate(room);
    broadcastGameOver(room);
    return;
  }

  if (room.players[room.currentPlayerIndex].id === player.id) {
    if (room.pileCount > 0) {
      room.consecutivePasses++;
      if (room.consecutivePasses >= room.activePlayers - 1) {
        const clearedCount = room.pile.length;
        room.pile = [];
        room.pileCount = 0;
        room.pileMinValue = -1;
        room.consecutivePasses = 0;
        for (const p of room.players) p.passed = false;
        let leadIdx;
        if (room.lastPlayerId) {
          const lastIdx = room.players.findIndex(p => p.id === room.lastPlayerId);
          if (lastIdx !== -1 && room.players[lastIdx].finishRank === null) {
            leadIdx = lastIdx;
          } else {
            leadIdx = findNextActivePlayer(room, room.currentPlayerIndex);
          }
        } else {
          leadIdx = findNextActivePlayer(room, room.currentPlayerIndex);
        }
        room.currentPlayerIndex = leadIdx;
        room.lastPlayerId = null;
        recordAction(room, {
          type: 'clear',
          cardsCleared: clearedCount,
          leadPlayerName: room.players[leadIdx].name
        });
      } else {
        room.currentPlayerIndex = findNextActivePlayer(room, room.currentPlayerIndex);
      }
    } else {
      room.currentPlayerIndex = findNextActivePlayer(room, room.currentPlayerIndex);
    }
  }
  broadcastRoomUpdate(room);
  checkAutoAdvance(room);
}

io.on('connection', (socket) => {
  socket.data = {};

  socket.on('join_room', ({ roomId, playerName }) => {
    if (!roomId || typeof roomId !== 'string' || !playerName || typeof playerName !== 'string') {
      return socket.emit('error', { message: 'בקשת הצטרפות לא תקינה' });
    }
    roomId = roomId.toUpperCase().trim();
    playerName = playerName.trim().slice(0, 24);
    if (!playerName) return socket.emit('error', { message: 'נדרש שם' });

    const room = rooms[roomId];
    if (!room) return socket.emit('error', { message: 'החדר לא נמצא' });

    const existing = room.players.find(p => p.name === playerName);
    if (existing) {
      if (existing.connected && existing.id !== socket.id) {
        return socket.emit('error', { message: 'השם כבר בשימוש בחדר הזה' });
      }
      const oldId = existing.id;
      existing.id = socket.id;
      existing.connected = true;
      if (room.creatorId === oldId) room.creatorId = socket.id;
      if (room.lastPlayerId === oldId) room.lastPlayerId = socket.id;
      socket.data.roomId = roomId;
      socket.data.playerName = playerName;
      const timerKey = `${roomId}:${playerName}`;
      if (disconnectTimers[timerKey]) {
        clearTimeout(disconnectTimers[timerKey]);
        delete disconnectTimers[timerKey];
      }
      socket.join(roomId);
      broadcastRoomUpdate(room);
      checkAutoAdvance(room);
      return;
    }

    if (room.state !== 'lobby') {
      return socket.emit('error', { message: 'המשחק כבר התחיל' });
    }
    if (room.players.length >= MAX_PLAYERS) {
      return socket.emit('error', { message: 'החדר מלא' });
    }

    room.players.push({
      id: socket.id,
      name: playerName,
      hand: [],
      passed: false,
      connected: true,
      finishRank: null,
      hideCount: false
    });
    if (!room.creatorId) room.creatorId = socket.id;
    socket.data.roomId = roomId;
    socket.data.playerName = playerName;
    socket.join(roomId);
    broadcastRoomUpdate(room);
  });

  socket.on('start_game', ({ roomId, mushiMode }) => {
    if (!roomId) return;
    roomId = String(roomId).toUpperCase().trim();
    const room = rooms[roomId];
    if (!room) return socket.emit('error', { message: 'החדר לא נמצא' });
    if (room.creatorId !== socket.id) return socket.emit('error', { message: 'רק היוצר יכול להתחיל' });
    if (room.state !== 'lobby') return socket.emit('error', { message: 'המשחק כבר התחיל' });
    if (room.players.length < MIN_PLAYERS) return socket.emit('error', { message: `נדרשים לפחות ${MIN_PLAYERS} שחקנים` });
    room.mushiMode = !!mushiMode && room.players.length === 2;
    startGame(room);
    broadcastRoomUpdate(room);
    checkAutoAdvance(room);
  });

  socket.on('toggle_hide_count', ({ roomId }) => {
    if (!roomId) return;
    roomId = String(roomId).toUpperCase().trim();
    const room = rooms[roomId];
    if (!room) return socket.emit('error', { message: 'החדר לא נמצא' });
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.hideCount = !player.hideCount;
    broadcastRoomUpdate(room);
  });

  socket.on('play_cards', ({ roomId, cards }) => {
    if (!roomId) return;
    roomId = String(roomId).toUpperCase().trim();
    const room = rooms[roomId];
    if (!room) return socket.emit('error', { message: 'החדר לא נמצא' });
    const result = doPlayCards(room, socket.id, cards);
    if (result.error) return socket.emit('error', { message: result.error });
    broadcastRoomUpdate(room);
    if (result.gameOver) broadcastGameOver(room);
    else checkAutoAdvance(room);
  });

  socket.on('pass', ({ roomId }) => {
    if (!roomId) return;
    roomId = String(roomId).toUpperCase().trim();
    const room = rooms[roomId];
    if (!room) return socket.emit('error', { message: 'החדר לא נמצא' });
    const result = doPass(room, socket.id, false);
    if (result.error) return socket.emit('error', { message: result.error });
    broadcastRoomUpdate(room);
    checkAutoAdvance(room);
  });

  socket.on('play_again', ({ roomId }) => {
    if (!roomId) return;
    roomId = String(roomId).toUpperCase().trim();
    const room = rooms[roomId];
    if (!room) return socket.emit('error', { message: 'החדר לא נמצא' });
    if (room.creatorId !== socket.id) return socket.emit('error', { message: 'רק היוצר יכול להתחיל מחדש' });
    if (room.state !== 'finished') return socket.emit('error', { message: 'המשחק חייב להסתיים' });
    room.state = 'lobby';
    room.pile = [];
    room.pileCount = 0;
    room.pileMinValue = -1;
    room.consecutivePasses = 0;
    room.lastPlayerId = null;
    room.lastAction = null;
    for (const p of room.players) {
      p.hand = [];
      p.passed = false;
      p.finishRank = null;
    }
    broadcastRoomUpdate(room);
  });

  socket.on('disconnect', () => {
    const { roomId, playerName } = socket.data;
    if (!roomId || !playerName) return;
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.connected = false;

    if (room.state === 'lobby') {
      room.players = room.players.filter(p => p.id !== player.id);
      if (room.players.length === 0) {
        delete rooms[roomId];
        return;
      }
      if (room.creatorId === player.id) {
        room.creatorId = room.players[0].id;
      }
      broadcastRoomUpdate(room);
    } else if (room.state === 'playing') {
      const timerKey = `${roomId}:${playerName}`;
      if (disconnectTimers[timerKey]) clearTimeout(disconnectTimers[timerKey]);
      disconnectTimers[timerKey] = setTimeout(() => {
        delete disconnectTimers[timerKey];
        handlePlayerTimeout(roomId, playerName);
      }, DISCONNECT_GRACE_MS);
      broadcastRoomUpdate(room);
      checkAutoAdvance(room);
    } else {
      broadcastRoomUpdate(room);
    }
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/room/create', (req, res) => {
  const id = generateRoomCode();
  rooms[id] = {
    id,
    creatorId: null,
    players: [],
    state: 'lobby',
    currentPlayerIndex: 0,
    pile: [],
    pileCount: 0,
    pileMinValue: -1,
    consecutivePasses: 0,
    activePlayers: 0,
    lastPlayerId: null,
    lastActivity: Date.now(),
    topFinishers: 0,
    bottomFinishers: 0,
    lastAction: null,
    actionCounter: 0,
    mushiMode: false
  };
  res.json({ roomId: id });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of Object.entries(rooms)) {
    if (now - (room.lastActivity || 0) > ROOM_IDLE_LIMIT_MS) {
      delete rooms[id];
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`skip server running on port ${PORT}`);
});
