require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Configuração CORS
const io = new Server(server, {
    cors: {
        origin: process.env.CLIENT_ORIGIN || "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());

// Estado do servidor
const users = new Map();          // socketId -> userData
const voiceRooms = new Map();     // roomId -> { name, users: Set<socketId>, limit }
const conversations = new Map();  // odels -> messages[]
const streams = new Map();        // odels -> streamData

// Salas padrão
voiceRooms.set('general', { name: 'Sala Geral', users: new Set(), limit: 0 });
voiceRooms.set('gaming', { name: 'Gaming', users: new Set(), limit: 0 });
voiceRooms.set('music', { name: 'Música', users: new Set(), limit: 0 });

// ============================================
// Rotas HTTP
// ============================================

app.get('/', (req, res) => {
    res.json({
        name: 'Abyss Connect Server',
        version: '1.0.0',
        team: 'The Abyss Team',
        leader: 'Raul Pereira Leite',
        status: 'online',
        connections: users.size,
        voiceRooms: Array.from(voiceRooms.entries()).map(([id, room]) => ({
            id,
            name: room.name,
            users: room.users.size
        }))
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/stats', (req, res) => {
    res.json({
        users: users.size,
        voiceRooms: voiceRooms.size,
        activeConversations: conversations.size,
        activeStreams: streams.size
    });
});

// ============================================
// Socket.IO Events
// ============================================

io.on('connection', (socket) => {
    console.log(`[+] Usuário conectado: ${socket.id}`);

    // ----------------------------------------
    // Autenticação e Perfil
    // ----------------------------------------
    
    socket.on('user:login', (userData) => {
        users.set(socket.id, {
            id: socket.id,
            name: userData.name || 'Anônimo',
            avatar: userData.avatar || null,
            status: 'online',
            ...userData
        });
        
        // Notifica todos sobre novo usuário
        io.emit('user:online', {
            id: socket.id,
            name: userData.name,
            status: 'online'
        });
        
        // Envia lista de usuários online
        socket.emit('users:list', Array.from(users.values()));
        
        console.log(`[*] ${userData.name} entrou`);
    });

    socket.on('user:update', (userData) => {
        const user = users.get(socket.id);
        if (user) {
            users.set(socket.id, { ...user, ...userData });
            io.emit('user:updated', { id: socket.id, ...userData });
        }
    });

    socket.on('user:status', (status) => {
        const user = users.get(socket.id);
        if (user) {
            user.status = status;
            io.emit('user:status-changed', { id: socket.id, status });
        }
    });

    // ----------------------------------------
    // Mensagens
    // ----------------------------------------

    socket.on('message:send', (data) => {
        const { to, text, type = 'text', audioData } = data;
        const sender = users.get(socket.id);
        
        const message = {
            id: uuidv4(),
            from: socket.id,
            fromName: sender?.name || 'Anônimo',
            fromAvatar: sender?.avatar,
            to,
            text,
            type,
            audioData,
            timestamp: new Date().toISOString()
        };

        // Salva na conversa
        const convId = [socket.id, to].sort().join('-');
        if (!conversations.has(convId)) {
            conversations.set(convId, []);
        }
        conversations.get(convId).push(message);

        // Envia para o destinatário
        io.to(to).emit('message:receive', message);
        
        // Confirma envio para o remetente
        socket.emit('message:sent', message);
        
        console.log(`[MSG] ${sender?.name} -> ${to}: ${type === 'audio' ? '[Áudio]' : text}`);
    });

    socket.on('message:typing', (data) => {
        const { to } = data;
        const user = users.get(socket.id);
        io.to(to).emit('message:typing', {
            from: socket.id,
            name: user?.name
        });
    });

    socket.on('messages:history', (data) => {
        const { with: otherId } = data;
        const convId = [socket.id, otherId].sort().join('-');
        const messages = conversations.get(convId) || [];
        socket.emit('messages:history', messages);
    });

    // ----------------------------------------
    // Chat de Voz
    // ----------------------------------------

    socket.on('voice:join', (data) => {
        const { roomId } = data;
        const room = voiceRooms.get(roomId);
        const user = users.get(socket.id);
        
        if (!room) {
            socket.emit('voice:error', { message: 'Sala não encontrada' });
            return;
        }

        if (room.limit > 0 && room.users.size >= room.limit) {
            socket.emit('voice:error', { message: 'Sala cheia' });
            return;
        }

        // Sai de outras salas de voz
        voiceRooms.forEach((r, id) => {
            if (r.users.has(socket.id)) {
                r.users.delete(socket.id);
                socket.leave(`voice:${id}`);
                io.to(`voice:${id}`).emit('voice:user-left', {
                    roomId: id,
                    userId: socket.id,
                    userName: user?.name
                });
            }
        });

        // Entra na nova sala
        room.users.add(socket.id);
        socket.join(`voice:${roomId}`);

        // Notifica outros na sala
        socket.to(`voice:${roomId}`).emit('voice:user-joined', {
            roomId,
            userId: socket.id,
            userName: user?.name,
            userAvatar: user?.avatar
        });

        // Envia lista de participantes
        const participants = Array.from(room.users).map(id => {
            const u = users.get(id);
            return { id, name: u?.name, avatar: u?.avatar };
        });
        socket.emit('voice:joined', { roomId, participants });

        // Atualiza contagem para todos
        io.emit('voice:room-updated', {
            roomId,
            userCount: room.users.size
        });

        console.log(`[VOZ] ${user?.name} entrou na sala ${roomId}`);
    });

    socket.on('voice:leave', (data) => {
        const { roomId } = data;
        const room = voiceRooms.get(roomId);
        const user = users.get(socket.id);

        if (room && room.users.has(socket.id)) {
            room.users.delete(socket.id);
            socket.leave(`voice:${roomId}`);

            io.to(`voice:${roomId}`).emit('voice:user-left', {
                roomId,
                userId: socket.id,
                userName: user?.name
            });

            io.emit('voice:room-updated', {
                roomId,
                userCount: room.users.size
            });

            console.log(`[VOZ] ${user?.name} saiu da sala ${roomId}`);
        }
    });

    socket.on('voice:create-room', (data) => {
        const { name, limit = 10 } = data;
        const roomId = uuidv4().substring(0, 8);
        const user = users.get(socket.id);

        voiceRooms.set(roomId, {
            name,
            users: new Set(),
            limit: parseInt(limit),
            createdBy: socket.id
        });

        io.emit('voice:room-created', {
            id: roomId,
            name,
            limit,
            userCount: 0,
            createdBy: user?.name
        });

        console.log(`[VOZ] Sala criada: ${name} (${roomId}) por ${user?.name}`);
    });

    // WebRTC Signaling
    socket.on('voice:offer', (data) => {
        const { to, offer } = data;
        io.to(to).emit('voice:offer', {
            from: socket.id,
            offer
        });
    });

    socket.on('voice:answer', (data) => {
        const { to, answer } = data;
        io.to(to).emit('voice:answer', {
            from: socket.id,
            answer
        });
    });

    socket.on('voice:ice-candidate', (data) => {
        const { to, candidate } = data;
        io.to(to).emit('voice:ice-candidate', {
            from: socket.id,
            candidate
        });
    });

    socket.on('voice:speaking', (data) => {
        const { roomId, speaking } = data;
        socket.to(`voice:${roomId}`).emit('voice:speaking', {
            userId: socket.id,
            speaking
        });
    });

    // ----------------------------------------
    // Transmissão de Tela
    // ----------------------------------------

    socket.on('stream:start', (data) => {
        const { quality, fps } = data;
        const user = users.get(socket.id);
        const streamId = uuidv4().substring(0, 8);

        streams.set(streamId, {
            id: streamId,
            userId: socket.id,
            userName: user?.name,
            userAvatar: user?.avatar,
            quality,
            fps,
            viewers: new Set(),
            startedAt: new Date().toISOString()
        });

        socket.join(`stream:${streamId}`);

        io.emit('stream:started', {
            streamId,
            userId: socket.id,
            userName: user?.name,
            userAvatar: user?.avatar
        });

        socket.emit('stream:created', { streamId });

        console.log(`[STREAM] ${user?.name} iniciou transmissão ${streamId}`);
    });

    socket.on('stream:stop', (data) => {
        const { streamId } = data;
        const stream = streams.get(streamId);

        if (stream && stream.userId === socket.id) {
            io.to(`stream:${streamId}`).emit('stream:ended', { streamId });
            streams.delete(streamId);
            console.log(`[STREAM] Transmissão ${streamId} encerrada`);
        }
    });

    socket.on('stream:watch', (data) => {
        const { streamId } = data;
        const stream = streams.get(streamId);

        if (stream) {
            stream.viewers.add(socket.id);
            socket.join(`stream:${streamId}`);

            io.to(`stream:${streamId}`).emit('stream:viewer-joined', {
                streamId,
                viewerCount: stream.viewers.size
            });

            // Solicita offer do streamer
            io.to(stream.userId).emit('stream:request-offer', {
                viewerId: socket.id
            });
        }
    });

    socket.on('stream:offer', (data) => {
        const { to, offer, streamId } = data;
        io.to(to).emit('stream:offer', {
            from: socket.id,
            offer,
            streamId
        });
    });

    socket.on('stream:answer', (data) => {
        const { to, answer } = data;
        io.to(to).emit('stream:answer', {
            from: socket.id,
            answer
        });
    });

    socket.on('stream:list', () => {
        const activeStreams = Array.from(streams.values()).map(s => ({
            id: s.id,
            userName: s.userName,
            userAvatar: s.userAvatar,
            viewerCount: s.viewers.size,
            startedAt: s.startedAt
        }));
        socket.emit('stream:list', activeStreams);
    });

    // ----------------------------------------
    // Desconexão
    // ----------------------------------------

    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        
        // Remove de salas de voz
        voiceRooms.forEach((room, roomId) => {
            if (room.users.has(socket.id)) {
                room.users.delete(socket.id);
                io.to(`voice:${roomId}`).emit('voice:user-left', {
                    roomId,
                    userId: socket.id,
                    userName: user?.name
                });
                io.emit('voice:room-updated', {
                    roomId,
                    userCount: room.users.size
                });
            }
        });

        // Encerra streams
        streams.forEach((stream, streamId) => {
            if (stream.userId === socket.id) {
                io.to(`stream:${streamId}`).emit('stream:ended', { streamId });
                streams.delete(streamId);
            }
            stream.viewers.delete(socket.id);
        });

        // Remove usuário
        users.delete(socket.id);
        io.emit('user:offline', { id: socket.id });

        console.log(`[-] Usuário desconectado: ${user?.name || socket.id}`);
    });
});

// ============================================
// Inicialização
// ============================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log('');
    console.log('============================================');
    console.log('     ABYSS CONNECT SERVER');
    console.log('     The Abyss Team');
    console.log('============================================');
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
    console.log('============================================');
    console.log('');
});
