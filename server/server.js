/**
 * Main server file for Beachside Racetrack.
 * Sets up Express, Socket.io, and handles all real-time race events.
 * Persists session and race state to config/data.json.
 */

require('dotenv').config();

const carAssignment = require('./car-assignment');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    transports: ['websocket']
});

const DATA_FILE = path.join(__dirname, '../config/data.json');

// Reads session and race state from disk, or returns defaults if the file doesn't exist yet.
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (err) {
        console.error("Error loading data:", err);
    }
    return {
        sessions: [],
        currentRaceState: { isActive: false, timeLeft: 600, currentRaceId: null, currentMode: 'safe' }
    };
}

// Writes the current state to disk so it survives server restarts.
function saveData(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error("Error saving data:", err);
    }
}

let db = loadData();
let raceTimer = null;

// Counts down every second and emits timer updates. Ends the race automatically when time runs out.
function startCountdown(duration, io) {
    if (raceTimer) {
        clearInterval(raceTimer);
        raceTimer = null;
    }

    db.currentRaceState.isActive = true;
    db.currentRaceState.timeLeft = duration;

    raceTimer = setInterval(() => {
        if (db.currentRaceState.timeLeft > 0) {
            db.currentRaceState.timeLeft--;
            io.emit('timer:update', { timeLeft: db.currentRaceState.timeLeft });

            // Save periodically rather than every second
            if (db.currentRaceState.timeLeft % 5 === 0) {
                saveData(db);
            }
        } else {
            clearInterval(raceTimer);
            raceTimer = null;

            db.currentRaceState.isActive = false;
            db.currentRaceState.currentMode = 'finished';

            const session = db.sessions.find(s => s.id === db.currentRaceState.currentRaceId);
            if (session) session.status = 'finished';

            io.emit('race:finished');
            io.emit('race:flag-updated', { status: 'finished' });
            io.emit('data:updated', db.sessions);

            saveData(db);
            console.log("Race finished: time is up.");
        }
    }, 1000);
}

// Clears the active countdown interval.
function stopCountdown() {
    if (raceTimer) {
        clearInterval(raceTimer);
        raceTimer = null;
    }
}

// Resume race if server restarted during an active session
if (db.currentRaceState && db.currentRaceState.isActive && db.currentRaceState.timeLeft > 0) {
    console.log(`Resuming active race: ${db.currentRaceState.timeLeft}s remaining.`);
    startCountdown(db.currentRaceState.timeLeft, io);
}

const requiredKeys = ['RECEPTIONIST_KEY', 'OBSERVER_KEY', 'SAFETY_KEY'];
requiredKeys.forEach(key => {
    if (!process.env[key] || process.env[key].trim() === "") {
        console.error(`ERROR: Environment variable "${key}" is missing or empty.`);
        process.exit(1);
    }
});

const raceDuration = process.env.NODE_ENV === 'dev' ? 60 : 600;
console.log(`Server started in ${process.env.NODE_ENV || 'production'} mode. Race duration: ${raceDuration}s.`);

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/front-desk', (req, res) => res.sendFile(path.join(__dirname, '../public/front-desk.html')));
app.get('/race-control', (req, res) => res.sendFile(path.join(__dirname, '../public/race-control.html')));
app.get('/lap-line-tracker', (req, res) => res.sendFile(path.join(__dirname, '../public/lap-line-tracker.html')));
app.get('/leader-board', (req, res) => res.sendFile(path.join(__dirname, '../public/leader-board.html')));
app.get('/next-race', (req, res) => res.sendFile(path.join(__dirname, '../public/next-race.html')));
app.get('/race-countdown', (req, res) => res.sendFile(path.join(__dirname, '../public/race-countdown.html')));
app.get('/race-flags', (req, res) => res.sendFile(path.join(__dirname, '../public/race-flags.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Beachside Racetrack server running on port ${PORT}`);
});

io.on('connection', (socket) => {
    socket.emit('data:updated', db.sessions);
    socket.emit('race:state', db.currentRaceState);

    // --- AUTHENTICATION ---
    socket.on('auth:check', ({ key, role }) => {
        const envKeyMap = {
            receptionist: 'RECEPTIONIST_KEY',
            observer: 'OBSERVER_KEY',
            safety: 'SAFETY_KEY'
        };
        const correctKey = process.env[envKeyMap[role]];
        setTimeout(() => {
            if (key === correctKey) {
                socket.emit('auth:success');
            } else {
                socket.emit('auth:error', { message: 'Invalid access key' });
            }
        }, 500);
    });

    // --- RACE CONTROL ---
    socket.on('race:start', ({ sessionId }) => {
        const session = db.sessions.find(s => s.id === sessionId);
        if (!session) {
            socket.emit('race:error', { message: 'Session not found.' });
            return;
        }
        if (session.drivers.length === 0) {
            socket.emit('race:error', { message: 'This session has no drivers. Cannot start a race.' });
            return;
        }

        session.status = 'active';
        db.currentRaceState = {
            isActive: true,
            timeLeft: raceDuration,
            currentRaceId: sessionId,
            currentMode: 'safe'
        };

        saveData(db);
        io.emit('data:updated', db.sessions);
        io.emit('race:started', { sessionId: session.id, mode: 'safe' });
        io.emit('race:flag-updated', { status: 'safe' });
        startCountdown(raceDuration, io);
    });

    socket.on('race:change-mode', ({ mode }) => {
        if (db.currentRaceState.currentMode === 'finished') {
            socket.emit('race:error', { message: 'Race is already finished.' });
            return;
        }

        db.currentRaceState.currentMode = mode;

        if (mode === 'finished') {
            db.currentRaceState.isActive = false;
            stopCountdown();
            const session = db.sessions.find(s => s.id === db.currentRaceState.currentRaceId);
            if (session) session.status = 'finished';
            io.emit('race:finished');
        }

        saveData(db);
        io.emit('race:flag-updated', { status: mode });
    });

    socket.on('race:end-session', () => {
        if (db.currentRaceState.currentMode !== 'finished') {
            socket.emit('race:error', { message: 'Finish the race first.' });
            return;
        }

        const finishedSession = db.sessions.find(s => s.id === db.currentRaceState.currentRaceId);
        const sessionIndex = db.sessions.findIndex(s => s.id === db.currentRaceState.currentRaceId);
        if (sessionIndex !== -1) db.sessions[sessionIndex].status = 'ended';

        if (finishedSession) {
            io.emit('race:next-session', { proceedToPaddock: true, session: finishedSession });
        }

        stopCountdown();
        db.currentRaceState = {
            isActive: false,
            timeLeft: raceDuration,
            currentRaceId: null,
            currentMode: 'danger'
        };

        saveData(db);
        io.emit('data:updated', db.sessions);
        io.emit('race:session-ended');
        io.emit('race:flag-updated', { status: 'danger' });
    });

    // --- LAP TRACKING ---
    socket.on('lap:register', ({ carNumber }) => {
        const activeSession = db.sessions.find(s => s.status === 'active');
        if (activeSession) {
            const driver = activeSession.drivers.find(d => d.car === parseInt(carNumber));
            if (driver) {
                if (!driver.laps) driver.laps = [];
                driver.laps.push(Date.now());
                saveData(db);
                io.emit('data:updated', db.sessions);
            }
        }
    });

    // --- SESSION MANAGEMENT ---
    socket.on('session:add', (sessionData) => {
        db.sessions.push({
            id: Date.now(),
            name: sessionData.name,
            status: 'pending',
            drivers: []
        });
        saveData(db);
        io.emit('data:updated', db.sessions);
    });

    socket.on('session:remove', ({ id }) => {
        db.sessions = db.sessions.filter(s => s.id !== id);
        saveData(db);
        io.emit('data:updated', db.sessions);
    });

    // --- STATE SYNC ---
    socket.on('request:data-refresh', () => {
        socket.emit('data:updated', db.sessions);
        socket.emit('race:state', db.currentRaceState);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

carAssignment.register(io, db, saveData);
