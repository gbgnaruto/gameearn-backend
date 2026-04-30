const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Create the real-time server
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// The WebSocket Connection Hub
io.on('connection', (socket) => {
    console.log(`Agent Connected: ${socket.id}`);

    // When someone loads a new video, broadcast it to everyone else
    socket.on('change_video', (videoId) => {
        socket.broadcast.emit('load_video', videoId);
    });

    // When someone hits PLAY
    socket.on('play_video', (time) => {
        socket.broadcast.emit('sync_play', time);
    });

    // When someone hits PAUSE
    socket.on('pause_video', (time) => {
        socket.broadcast.emit('sync_pause', time);
    });

    socket.on('disconnect', () => {
        console.log(`Agent Disconnected: ${socket.id}`);
    });
});

app.get('/', (req, res) => {
    res.send("Watch Party WebSocket Server is Live!");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`WebSockets running on port ${PORT}`);
});
