const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Store the ID of the person sharing their screen
let broadcaster;

io.on('connection', (socket) => {
    console.log(`Agent Connected: ${socket.id}`);

    // 1. Host announces they are starting a stream
    socket.on('broadcaster', () => {
        broadcaster = socket.id;
        socket.broadcast.emit('broadcaster'); // Tell everyone else a stream started
    });

    // 2. A Viewer asks to connect to the Host
    socket.on('watcher', () => {
        if (broadcaster) {
            socket.to(broadcaster).emit('watcher', socket.id);
        }
    });

    // 3. WebRTC Handshake Routing (Offers, Answers, ICE Candidates)
    socket.on('offer', (id, message) => {
        socket.to(id).emit('offer', socket.id, message);
    });

    socket.on('answer', (id, message) => {
        socket.to(id).emit('answer', socket.id, message);
    });

    socket.on('candidate', (id, message) => {
        socket.to(id).emit('candidate', socket.id, message);
    });

    socket.on('disconnect', () => {
        if (broadcaster) {
            socket.to(broadcaster).emit('disconnectPeer', socket.id);
        }
    });
});

app.get('/', (req, res) => {
    res.send("WebRTC Signaling Server is Live!");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`WebRTC running on port ${PORT}`);
});
