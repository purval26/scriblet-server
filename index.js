const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const wordpacks = require("./wordpacks");

const app = express();
app.use(
  cors({
    origin: process.env.CLIENT_URL || "*",
    credentials: true,
  })
);
app.use(express.json());

const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: process.env.CLIENT_URL || "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Basic route for health check
app.get("/", (req, res) => {
  res.send("Scriblet server is running!");
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// --- In-memory state ---
const rooms = new Map(); // roomId -> room object
const userToRoom = new Map(); // socketId -> roomId
const disconnectedPlayers = new Map(); // socketId -> {roomId, playerData}

// --- Helper functions ---
function createRoom(settings, hostSocket, username) {
  const roomId = uuidv4().slice(0, 6);
  const room = {
    id: roomId,
    host: hostSocket.id,
    players: new Map([[hostSocket.id, { username, score: 0, isHost: true }]]),
    settings: {
      maxPlayers: settings.maxPlayers || 4,
      drawTime: settings.drawTime || 60,
      chooseTime: settings.chooseTime || 60, // <-- Add this
      wordOptions: settings.wordOptions || 3,
      difficulty: settings.difficulty || "Normal",
      hintsEnabled: settings.hintsEnabled ?? true,
      hintCount: settings.hintCount || 2,
      rounds: settings.rounds || 3,
      customWords: settings.customWords || [],
    },

    state: {
      isPlaying: false,
      currentDrawer: hostSocket.id,
      word: null,
      round: 1,
      timer: null,
      correctGuesses: new Set(),
      drawingData: [],
      chat: [],
    },
  };
  rooms.set(roomId, room);
  userToRoom.set(hostSocket.id, roomId);
  return room;
}

function getRoomPlayers(room) {
  return Array.from(room.players.values()).map((p, i) => ({
    ...p,
    avatar: `mascot${(i % 6) + 1}.png`,
  }));
}

function cleanupRoom(roomId) {
  rooms.delete(roomId);
}

// --- Helper for random word ---
function getRandomWords(room, count) {
  const wordPack = wordpacks[room.settings.difficulty] || wordpacks.Normal;
  const customWords = room.settings.customWords || [];
  const pool = [...customWords, ...wordPack];
  const shuffled = pool.sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

// --- Scoring helper function ---
function calculatePoints(timeLeft, maxTime, roomId) {
  // Base points between 100-300
  const basePoints = 100;
  const maxBonus = 200;

  // Calculate time bonus (0-200 points based on speed)
  const timeBonus = Math.ceil((timeLeft / maxTime) * maxBonus);

  // Round to nearest 10
  const totalPoints = Math.round((basePoints + timeBonus) / 10) * 10;

  
  console.log(
    `[SCORING] Time left: ${timeLeft}/${maxTime}, Points awarded: ${totalPoints}`
  );
  
  // Remove this emit from here as we'll handle it in the chat-message handler
  return totalPoints;
}

// Add this new function to calculate drawer points
function calculateDrawerPoints(correctGuesses, totalPlayers, roomId) {
  // Add after other const declarations at the top
const ALL_GUESSED_BONUS = 50;  // Bonus points when everyone guesses
const PER_GUESS_POINTS = 25;   // Points per correct guess
  if (!correctGuesses || !totalPlayers) return 0;
  
  const nonDrawerCount = Math.max(0, totalPlayers - 1);
  if (nonDrawerCount === 0) return 0;

  if (correctGuesses >= nonDrawerCount) {
    return ALL_GUESSED_BONUS + (PER_GUESS_POINTS * correctGuesses);
  } else if (correctGuesses > 0) {
    return PER_GUESS_POINTS * correctGuesses;
  }
  return 0;
}

// --- Game progression helpers ---
function nextDrawer(room) {
  const playerIds = Array.from(room.players.keys());
  const currentIdx = playerIds.indexOf(room.state.currentDrawer);
  const nextIdx = (currentIdx + 1) % playerIds.length;
  return playerIds[nextIdx];
}
function startGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  console.log(`[SERVER] startGame: Starting game for room ${roomId}`);
  console.log(
    `[SERVER] startGame: Players in room:`,
    Array.from(room.players.keys())
  );

  // Randomize player order for fairness
  const playerIds = Array.from(room.players.keys());
  const shuffled = playerIds.sort(() => 0.5 - Math.random());
  room.state.playerOrder = shuffled; // Save the order for this game
  room.state.turn = 0;
  room.state.round = 1;
  room.state.isPlaying = true;

  // Reset all player scores
  Array.from(room.players.values()).forEach((p) => (p.score = 0));

  // Broadcast game started to all players
  io.to(roomId).emit("game-state-update", {
    isPlaying: true,
    round: 1,
    turn: 0,
    scores: {},
    drawTime: room.settings.drawTime,
    chooseTime: room.settings.chooseTime,
    isChoosing: false,
  });

  console.log(`[SERVER] startGame: Broadcasted game start to room ${roomId}`);

  // Start the first turn after a short delay
  setTimeout(() => {
    console.log(`[SERVER] startGame: Starting first turn for room ${roomId}`);
    startTurn(roomId);
  }, 1000);
}

function startRound(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.state.round = room.state.round || 1;
  room.state.turn = 0;
  room.state.isPlaying = true;
  room.state.scores = room.state.scores || {};
  // Don't shuffle here; use the order set at game start
  startTurn(roomId);
}

function startTurn(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  // Clear any existing interval
  if (room.state.timerInterval) {
    clearInterval(room.state.timerInterval);
    room.state.timerInterval = null;
  }

  // Reset turn state
  room.state.isChoosing = true;
  room.state.word = null;
  room.state.revealedIndices = new Set();
  room.state.correctGuesses = new Set();
  room.state.drawingData = [];
  room.state.timeLeft = room.settings.chooseTime;
  room.state.timerType = "choose";

  // Update current drawer
  const playerOrder = room.state.playerOrder || Array.from(room.players.keys());
  room.state.currentDrawer = playerOrder[room.state.turn % playerOrder.length];
  if (!room.players.has(room.state.currentDrawer)) {
    // Pick the first available player as drawer
    room.state.currentDrawer = Array.from(room.players.keys())[0];
  }

  // Clear canvas for everyone
  io.to(roomId).emit("canvas-clear");
  io.to(roomId).emit("drawing-data", JSON.stringify([]));

  // Generate word choices
  room.state.wordChoices = getRandomWords(room, room.settings.wordOptions);

  // Start choose timer
  room.state.timerInterval = setInterval(() => {
    if (room.state.timeLeft > 0) {
      room.state.timeLeft--;

      // Send timer update
      io.to(roomId).emit("timer-update", {
        timeLeft: room.state.timeLeft,
        timerType: "choose",
      });

      // Auto-select word if time runs out
      if (room.state.timeLeft === 0) {
        clearInterval(room.state.timerInterval);
        const randomWord =
          room.state.wordChoices[
            Math.floor(Math.random() * room.state.wordChoices.length)
          ];
        handleWordChosen(roomId, randomWord);
      }
    }
  }, 1000);

  // Send initial states
  const baseGameState = {
    drawer: room.players.get(room.state.currentDrawer).username,
    drawerId: room.state.currentDrawer,
    isChoosing: true,
    timeLeft: room.state.timeLeft,
    timerType: "choose",
    round: room.state.round,
    turn: room.state.turn,
    roundEnd: false,
  };

  // Send to everyone first
  io.to(roomId).emit("game-state-update", baseGameState);

  // Then send word choices to drawer
  io.to(room.state.currentDrawer).emit("game-state-update", {
    ...baseGameState,
    wordChoices: room.state.wordChoices,
  });
}

function handleWordChosen(roomId, word) {
  const room = rooms.get(roomId);
  if (!room) return;

  // Clear any existing interval
  if (room.state.timerInterval) {
    clearInterval(room.state.timerInterval);
    room.state.timerInterval = null;
  }
  // Initialize drawing phase state
  room.state.word = word;
  room.state.isChoosing = false;
  room.state.timeLeft = room.settings.drawTime;
  room.state.timerType = "draw";
  room.state.startTime = Date.now();
  room.state.drawingData = [];
  room.state.revealedIndices = new Set();
  room.state.correctGuesses = new Set();

  // Calculate hint timing
  const totalTime = room.settings.drawTime;
  const hintEndTime = Math.floor(totalTime * 0.4); // Last 40% of time has no hints
  const timeForHints = totalTime - hintEndTime;
  
  // Get number of hints from settings
  room.state.hintCount = Math.min(
    room.settings.hintCount || 2,
    Math.floor(word.length / 2)
  );

  // Generate random hint times within the first 60% of time
  const hintTimes = Array.from({ length: room.state.hintCount }, () => {
    // Random time between totalTime and hintEndTime
    return hintEndTime + Math.floor(Math.random() * timeForHints);
  }).sort((a, b) => b - a); // Sort in descending order so earlier times come first

  console.log(`[HINTS] Total hints: ${room.state.hintCount}`);
  console.log(`[HINTS] Hint times:`, hintTimes);
  console.log(`[HINTS] Draw time range: ${hintEndTime} - ${totalTime}`);

  // Clear canvas for everyone
  io.to(roomId).emit("canvas-clear");

  // Send initial states with consistent data
  const drawerPlayer = room.players.get(room.state.currentDrawer);
  const baseGameState = {
    drawer: drawerPlayer ? drawerPlayer.username : "Unknown",
    drawerId: room.state.currentDrawer,
    isChoosing: false,
    timeLeft: room.state.timeLeft,
    timerType: "draw",
    round: room.state.round,
    turn: room.state.turn,
    hiddenWord: "_"
      .repeat(word.length)
      .split("")
      .map((c) => " ")
      .join("_"),
  };

  // Send word to drawer only
  io.to(room.state.currentDrawer).emit("game-state-update", {
    ...baseGameState,
    word: word,
    isDrawer: true,
  });

  // Send hidden word to guessers only (not the drawer)
  io.to(roomId)
    .except(room.state.currentDrawer)
    .emit("game-state-update", {
      ...baseGameState,
      isDrawer: false,
      hiddenWord: "_".repeat(word.length).split("").join(" "),
    });

  // Start draw timer
  room.state.timerInterval = setInterval(() => {
    const timeLeft = room.state.timeLeft;

    if (timeLeft > 0) {
      room.state.timeLeft--;

      // Debug hint timing
      if (hintTimes.includes(timeLeft)) {
        console.log(`[HINTS] Time for hint! Time left: ${timeLeft}`);
        console.log(`[HINTS] Current hints revealed: ${room.state.revealedIndices.size}`);
      }

      // Check if it's time for a hint
      if (
        hintTimes.includes(timeLeft) &&
        room.state.revealedIndices.size < room.state.hintCount
      ) {
        const newHint = getNextHintIndex(word, room.state.revealedIndices);
        if (newHint !== -1) {
          room.state.revealedIndices.add(newHint);
          console.log(`[HINTS] Revealed new hint at index: ${newHint}`);

          // Broadcast hint to all guessers with improved word display
          const revealedWord = Array.from(word)
            .map((letter, i) => {
              if (room.state.revealedIndices.has(i)) return letter;
              if (letter === " ") return " ";
              // Add visual separator between words
              if (i > 0 && word[i - 1] === " ") return "‖_";
              return "_";
            })
            .join("");

          io.to(roomId)
            .except(room.state.currentDrawer)
            .emit("hint-update", {
              indices: Array.from(room.state.revealedIndices),
              hiddenWord: revealedWord,
              hintNumber: room.state.revealedIndices.size,
              totalHints: room.state.hintCount,
            });
        }
      }

      // Send timer update with hint info
      io.to(roomId).emit("timer-update", {
        timeLeft: timeLeft,
        timerType: "draw",
        hintsRevealed: room.state.revealedIndices.size,
        totalHints: room.state.hintCount,
      });
    } else {
      clearInterval(room.state.timerInterval);
      endTurn(roomId);
    }
  }, 1000);
}

function endTurn(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  // Calculate drawer points if any guesses were made
  const drawer = room.players.get(room.state.currentDrawer);
  if (room.state.correctGuesses.size > 0 && drawer) {
    const drawerPoints = calculateDrawerPoints(
      room.state.correctGuesses.size,
      room.players.size,
      roomId
    );
    drawer.lastAwardedPoints = drawerPoints;
    drawer.score += drawerPoints;
  }

  // Build awardedPoints for this round
  const awardedPoints = {};
  for (const [id, player] of room.players.entries()) {
    // Include points for this round before resetting
    awardedPoints[player.username] = player.lastAwardedPoints || 0;
  }

  io.to(roomId).emit("game-state-update", {
    roundEnd: true,
    scores: Object.fromEntries(
      Array.from(room.players.entries()).map(([id, p]) => [p.username, p.score])
    ),
    awardedPoints,
    word: room.state.word,
  });

  // Now reset the lastAwardedPoints for next round
  for (const player of room.players.values()) {
    player.lastAwardedPoints = 0;
  }

  // Next turn or next round
  room.state.turn = (room.state.turn || 0) + 1;
  const playerOrder = room.state.playerOrder || Array.from(room.players.keys());
  if (room.state.turn % playerOrder.length === 0) {
    room.state.round = (room.state.round || 1) + 1;
    if (room.state.round > (room.settings.rounds || 3)) {
      // Game over
      io.to(roomId).emit("game-end", {
        scores: Object.fromEntries(
          Array.from(room.players.entries()).map(([id, p]) => [
            p.username,
            p.score,
          ])
        ),
      });
      room.state.isPlaying = false;
      return;
    }
  }
  setTimeout(() => startTurn(roomId), 4000); // Short break between turns
}

// --- Socket.IO events ---
io.on("connection", (socket) => {
  console.log(`[SOCKET] Connected: ${socket.id}`);

  socket.onAny((event, ...args) => {
    console.log(`[SOCKET] Event received: ${event}`, args);
  });

  // When creating a room
  socket.on("create-room", ({ settings, username }) => {
    const room = createRoom(settings, socket, username);
    userToRoom.set(socket.id, room.id);
    socket.join(room.id); // <-- Host joins the room!
    socket.emit("room-created", {
      roomId: room.id,
      players: getRoomPlayers(room),
      host: room.host,
      settings: room.settings,
    });
    io.to(room.id).emit("room-update", {
      roomId: room.id,
      players: getRoomPlayers(room),
      host: room.host,
      settings: room.settings,
    });
    console.log(`[SERVER] room-update emitted to room ${room.id}:`, {
      players: getRoomPlayers(room),
      host: room.host,
      settings: room.settings,
    });
    console.log(
      `[SERVER] Sockets in room ${room.id}:`,
      Array.from(io.sockets.adapter.rooms.get(room.id) || [])
    );
    console.log(
      `[SERVER] Room created: ${room.id} by ${username} (${socket.id})`
    );
  });

  // When joining a room
  socket.on("join-room", ({ roomId, username }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit("error", { message: "Room not found" });

    // Check for existing player data
    const existingPlayer = Array.from(room.players.entries()).find(
      ([_, player]) => player.username === username
    );

    if (existingPlayer) {
      // Rejoin logic - keep existing
      const [oldSocketId, playerData] = existingPlayer;
      room.players.delete(oldSocketId);
      room.players.set(socket.id, playerData);
      userToRoom.set(socket.id, roomId);
      socket.join(roomId);

      // Update socket references if this was the drawer
      if (room.state.currentDrawer === oldSocketId) {
        room.state.currentDrawer = socket.id;
      }

      // Send current game state for rejoin
      socket.emit("room-joined", {
        roomId: room.id,
        players: getRoomPlayers(room),
        host: room.host,
        settings: room.settings,
        gameState: {
          isPlaying: room.state.isPlaying,
          drawer: room.players.get(room.state.currentDrawer)?.username,
          drawerId: room.state.currentDrawer,
          word: room.state.currentDrawer === socket.id ? room.state.word : null,
          isChoosing: room.state.isChoosing,
          drawingData: room.state.drawingData,
          timeLeft: room.state.timeLeft,
          scores: Object.fromEntries(
            Array.from(room.players.entries()).map(([id, p]) => [
              p.username,
              p.score,
            ])
          ),
        },
      });
    } else {
      // New player joining
      if (room.players.size >= room.settings.maxPlayers) {
        return socket.emit("error", { message: "Room is full" });
      }

      // Add new player with initial score
      room.players.set(socket.id, { username, score: 0, isHost: false });
      userToRoom.set(socket.id, roomId);
      socket.join(roomId);

      // If game is in progress, send game state
      if (room.state.isPlaying) {
        const hiddenWord = room.state.word
          ? Array.from(room.state.word)
              .map((letter, i) => {
                if (room.state.revealedIndices.has(i)) return letter;
                if (letter === " ") return " ";
                return "_";
              })
              .join(" ") // Add space between characters
          : "";

        const gameState = {
          isPlaying: true,
          drawer: room.players.get(room.state.currentDrawer)?.username,
          drawerId: room.state.currentDrawer,
          isChoosing: room.state.isChoosing,
          timeLeft: room.state.timeLeft,
          drawingData: room.state.drawingData,
          hiddenWord: hiddenWord,
          timerType: room.state.timerType,
          round: room.state.round,
          turn: room.state.turn,
          scores: Object.fromEntries(
            Array.from(room.players.entries()).map(([id, p]) => [
              p.username,
              p.score,
            ])
          ),
          hintsRevealed: room.state.revealedIndices.size,
          totalHints: room.state.hintCount
        };

        socket.emit("room-joined", {
          roomId: room.id,
          players: getRoomPlayers(room),
          host: room.host,
          settings: room.settings,
          gameState: gameState
        });

        // Send current drawing data immediately after join
        if (room.state.drawingData && room.state.drawingData.length > 0) {
          socket.emit("drawing-data", room.state.drawingData);
        }
      }

      // Notify others (without System: prefix)
      io.to(roomId).emit("chat-message", {
        message: `${username} joined the game`,
        isSystem: true
      });
    }

    // Broadcast update to other players
    socket.to(roomId).emit("room-update", {
      roomId: room.id,
      players: getRoomPlayers(room),
      host: room.host,
      settings: room.settings,
    });
  });

  socket.on("start-game", () => {
    const roomId = userToRoom.get(socket.id);
    const room = rooms.get(roomId);
    console.log(
      `[EVENT] start-game | socket: ${socket.id} | roomId: ${roomId}`
    );
    if (!room || room.host !== socket.id) {
      console.log(`[ERROR] start-game | Not host or room missing`);
      return;
    }
    startGame(roomId); // <-- This will now be defined!
  });

  socket.on("select-word", ({ word }) => {
    const roomId = userToRoom.get(socket.id);
    const room = rooms.get(roomId);

    // Add validation
    if (
      !room ||
      room.state.currentDrawer !== socket.id ||
      !room.state.isChoosing ||
      !room.state.wordChoices.includes(word)
    ) {
      return;
    }

    console.log(`[SERVER] Word selected: ${word} by ${socket.id}`);
    handleWordChosen(roomId, word);
  });

  socket.on("drawing-data", (data) => {
    const roomId = userToRoom.get(socket.id);
    const room = rooms.get(roomId);

    console.log(
      `[SERVER] Received drawing-data from ${
        socket.id
      }, typeof data: ${typeof data}`
    );
    console.log(`[SERVER] Raw data:`, data);

    if (!room || room.state.currentDrawer !== socket.id) return;

    // Try parsing if it's a string
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
        console.log("[SERVER] Parsed JSON:", data);
      } catch (e) {
        console.log("[SERVER] JSON parse error:", e);
        return;
      }
    }

    // New structure: data is expected to be List<List<DrawPoint>>
    if (!Array.isArray(data)) {
      console.log("[SERVER] Invalid drawing data root (not an array)", data);
      return;
    }

    // Validate strokes format
    const isValid = data.every(
      (stroke) =>
        stroke === null ||
        (Array.isArray(stroke) &&
          stroke.every(
            (point) =>
              point === null ||
              (Array.isArray(point) &&
                point.length === 4 &&
                typeof point[0] === "number" && // x
                typeof point[1] === "number" && // y
                typeof point[2] === "number" && // color (int)
                typeof point[3] === "number") // strokeWidth
          ))
    );

    if (!isValid) {
      console.log("[SERVER] Invalid drawing data structure", data);
      return;
    }

    // Save and broadcast
    room.state.drawingData = data;
    socket.to(roomId).emit("drawing-data", data);

    console.log(
      `[SERVER] Drawing data sent to room ${roomId}, strokes: ${data.length}`
    );
  });

  socket.on("clear-canvas", () => {
    const roomId = userToRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || room.state.currentDrawer !== socket.id) return;

    room.state.drawingData = []; // Clear it here too (optional)

    io.to(roomId).emit("clear-canvas");
    console.log(`[SERVER] Canvas cleared for room ${roomId}`);
  });

  socket.on("chat-message", ({ message }) => {
    const roomId = userToRoom.get(socket.id);
    const room = rooms.get(roomId);

    if (!room || !room.state) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    // Validate drawer exists
    const drawer = room.players.get(room.state.currentDrawer);
    if (!drawer && room.state.isPlaying) {
      // Drawer missing - end turn and reassign
      console.log('[ERROR] Drawer not found, ending turn');
      if (room.state.timerInterval) {
        clearInterval(room.state.timerInterval);
      }
      endTurn(roomId);
      return;
    }

    const isDrawer = socket.id === room.state.currentDrawer;

    // Always allow chat messages from drawer or during choosing phase
    if (isDrawer || room.state.isChoosing || !room.state.word) {
      io.to(roomId).emit("chat-message", {
        username: player.username,
        message,
        isDrawer,
      });
      return;
    }

    // Handle guessing during draw phase
    const normalizedGuess = message.toLowerCase().trim();
    const normalizedWord = room.state.word.toLowerCase().trim();
    const isCorrectGuess = normalizedGuess === normalizedWord && 
                          !room.state.correctGuesses.has(socket.id);

    if (isCorrectGuess) {
      // Award points to guesser
      const points = calculatePoints(room.state.timeLeft, room.settings.drawTime, roomId);
      player.lastAwardedPoints = points;
      player.score += points;
      room.state.correctGuesses.add(socket.id);

      // Notify about correct guess
      io.to(roomId).emit("chat-message", {
        message: `${player.username} guessed correctly!`,
        type: "correct-guess"
      });

      // Check if everyone guessed
      const nonDrawerCount = room.players.size - 1;
      if (room.state.correctGuesses.size >= nonDrawerCount) {
        // Double check drawer still exists
        const currentDrawer = room.players.get(room.state.currentDrawer);
        if (currentDrawer) {
          const drawerPoints = calculateDrawerPoints(
            room.state.correctGuesses.size,
            room.players.size,
            roomId
          );
          
          currentDrawer.lastAwardedPoints = drawerPoints;
          currentDrawer.score += drawerPoints;

          // Emit drawer points
          io.to(roomId).emit("word-end", {
            awardedPoints: {
              [currentDrawer.username]: drawerPoints
            },
            word: room.state.word
          });
        }

        // End turn regardless of drawer presence
        if (room.state.timerInterval) {
          clearInterval(room.state.timerInterval);
        }
        endTurn(roomId);
      }
    } else {
      // Regular chat message
      io.to(roomId).emit("chat-message", {
        username: player.username,
        message,
        isDrawer: false,
      });
    }
  });

  socket.on("skip-turn", () => {
    // Implement skip logic
  });

  socket.on("kick-player", ({ playerId }) => {
    const roomId = userToRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id) return;
    room.players.delete(playerId);
    io.to(roomId).emit("room-update", {
      roomId,
      players: getRoomPlayers(room),
      host: room.host,
      settings: room.settings, // Always include settings
    });
    io.to(playerId).emit("kicked");
    userToRoom.delete(playerId);
  });

  socket.on("disconnect", () => {
    console.log(`[SOCKET] Disconnected: ${socket.id}`);
    const roomId = userToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    // Remove player from room
    room.players.delete(socket.id);
    userToRoom.delete(socket.id);

    // If room becomes empty, clean up
    if (room.players.size === 0) {
      console.log(`[INFO] Room empty, cleaning up: ${roomId}`);
      cleanupRoom(roomId);
    } else {
      // If host disconnects, assign new host
      if (room.host === socket.id) {
        room.host = Array.from(room.players.keys())[0];
        room.players.get(room.host).isHost = true;
        console.log(
          `[INFO] Host left, new host: ${room.players.get(room.host).username}`
        );
      }
      // Notify room update
      io.to(roomId).emit("room-update", {
        roomId,
        players: getRoomPlayers(room),
        host: room.host,
        settings: room.settings, // Always include settings
      });

      // Notify about player leaving (without System: prefix)
      io.to(roomId).emit("chat-message", {
        message: `${player.username} left the game`,
        isSystem: true
      });
    }
  });

  socket.on("get-room", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room) {
      console.log(`[SERVER] get-room for ${roomId} by ${socket.id}`);
      socket.emit("room-update", {
        roomId: room.id,
        players: getRoomPlayers(room),
        host: room.host,
        settings: room.settings,
      });
    }
  });

  socket.on("update-room-settings", ({ roomId, settings }) => {
    console.log("[SERVER] update-room-settings received:", settings);
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.host !== socket.id) return; // Only host can edit
    room.settings = { ...room.settings, ...settings }; // <-- Overwrite settings!
    console.log(
      `[SERVER] Broadcasting room-update to room ${roomId}:`,
      room.settings
    );
    io.to(roomId).emit("room-update", {
      roomId: room.id,
      players: getRoomPlayers(room),
      host: room.host,
      settings: room.settings, // Always send latest settings
    });
  });
});

// --- API Endpoints ---
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
  console.log("Ping Successful");
});

app.get("/rooms", (req, res) => {
  const activeRooms = Array.from(rooms.values()).map((room) => ({
    id: room.id,
    playerCount: room.players.size,
    maxPlayers: room.settings.maxPlayers,
    isPlaying: room.state.isPlaying,
  }));
  res.json(activeRooms);
});

// // Helper function to calculate when to show next hint
// function calculateNextHintTime(totalTime, hintCount) {
//   if (hintCount <= 0) return 0;

//   // All hints should be revealed by 66.7% of time passed (33.3% remaining)
//   const hintEndTime = Math.floor(totalTime * 0.333);
//   const hintStartTime = totalTime;
//   const timePerHint = (hintStartTime - hintEndTime) / hintCount;

//   return Math.floor(hintStartTime - timePerHint);
// }

// // Helper function to get next letter to reveal
// function getNextHint(word, revealedIndices) {
//   // Filter out spaces and already revealed indices
//   const available = Array.from(word)
//     .map((_, i) => i)
//     .filter((i) => word[i] !== " " && !revealedIndices.has(i));

//   if (available.length === 0) return -1;

//   // Return random available index
//   return available[Math.floor(Math.random() * available.length)];
// }

// Helper function to get next letter to reveal with position priority
function getNextHintIndex(word, revealedIndices) {
  // First get all valid indices (non-space, non-revealed)
  const availableIndices = Array.from(word)
    .map((char, i) => ({ char, i }))
    .filter(({ char, i }) => char !== " " && !revealedIndices.has(i))
    .map(({ i }) => i);

  if (availableIndices.length === 0) return -1;

  // Group indices by character frequency to reveal rarer letters first
  const frequency = {};
  for (let i = 0; i < word.length; i++) {
    const char = word[i].toLowerCase();
    if (char !== " " && !revealedIndices.has(i)) {
      frequency[char] = (frequency[char] || 0) + 1;
    }
  }

  // Sort available indices by character frequency (rarer characters first)
  const sortedIndices = availableIndices.sort((a, b) => {
    const freqA = frequency[word[a].toLowerCase()];
    const freqB = frequency[word[b].toLowerCase()];
    if (freqA !== freqB) return freqA - freqB; // Rarer letters first

    // If same frequency, prefer revealing vowels later
    const isVowelA = "aeiou".includes(word[a].toLowerCase());
    const isVowelB = "aeiou".includes(word[b].toLowerCase());
    if (isVowelA !== isVowelB) return isVowelA ? 1 : -1;

    return 0;
  });

  // Return the first index (rarest character) with some randomization
  const randomOffset = Math.floor(
    Math.random() * Math.min(3, sortedIndices.length)
  );
  return sortedIndices[randomOffset];
}

// // --- Fix for drawer assignment ---
// function ensureDrawerAssigned(room) {
//   if (!room.players.has(room.state.currentDrawer)) {
//     // Pick the first available player as drawer
//     room.state.currentDrawer = Array.from(room.players.keys())[0];
//   }
// }
