require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { pool, initializeDatabase } = require('./database');

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

// Estado do servidor (em memória para performance real-time)
const users = new Map();          // socketId -> userData
const voiceRooms = new Map();     // roomId -> { name, users: Set<socketId>, limit }
const conversations = new Map();  // conversationId -> messages[]
const streams = new Map();        // streamId -> streamData

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
// Autenticação e Usuários
// ============================================

app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Campos obrigatórios' });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const result = await pool.query(
            'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
            [username, email, passwordHash]
        );

        res.status(201).json({ user: result.rows[0] });
    } catch (error) {
        console.error('[API] Erro de registro:', error);
        res.status(500).json({ error: 'Erro ao registrar' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        const user = result.rows[0];
        const isValidPassword = await bcrypt.compare(password, user.password_hash);

        if (!isValidPassword) {
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        res.json({
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar: user.avatar
            }
        });
    } catch (error) {
        console.error('[API] Erro de login:', error);
        res.status(500).json({ error: 'Erro ao fazer login' });
    }
});

// ============================================
// Servidores
// ============================================

app.get('/api/servers/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        const result = await pool.query(`
            SELECT s.* FROM servers s
            INNER JOIN server_members sm ON s.id = sm.server_id
            WHERE sm.user_id = $1
            ORDER BY s.created_at DESC
        `, [userId]);

        res.json({ servers: result.rows });
    } catch (error) {
        console.error('[API] Erro ao buscar servidores:', error);
        res.status(500).json({ error: 'Erro ao buscar servidores' });
    }
});

app.post('/api/servers', async (req, res) => {
    try {
        const { name, ownerId, description, icon } = req.body;

        if (!name || !ownerId) {
            return res.status(400).json({ error: 'Nome e proprietário obrigatórios' });
        }

        const serverResult = await pool.query(
            'INSERT INTO servers (name, owner_id, description, icon) VALUES ($1, $2, $3, $4) RETURNING *',
            [name, ownerId, description, icon]
        );

        const serverId = serverResult.rows[0].id;

        // Adicionar owner como membro
        await pool.query(
            'INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3)',
            [serverId, ownerId, 'owner']
        );

        // Criar canal padrão
        await pool.query(
            'INSERT INTO channels (server_id, name, type) VALUES ($1, $2, $3)',
            [serverId, 'geral', 'text']
        );

        res.status(201).json({ server: serverResult.rows[0] });
    } catch (error) {
        console.error('[API] Erro ao criar servidor:', error);
        res.status(500).json({ error: 'Erro ao criar servidor' });
    }
});

app.post('/api/servers/:serverId/invite', async (req, res) => {
    try {
        const { serverId } = req.params;
        const { userId } = req.body;

        await pool.query(
            'INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3)',
            [serverId, userId, 'member']
        );

        res.json({ success: true });
    } catch (error) {
        console.error('[API] Erro ao convidar:', error);
        res.status(500).json({ error: 'Erro ao convidar usuário' });
    }
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
    // ----------------------------------------
    // Mensagens Diretas
    // ----------------------------------------

    socket.on('dm:send', (data) => {
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

        //Salva na conversa
        const convId = [socket.id, to].sort().join('-');
        if (!conversations.has(convId)) {
            conversations.set(convId, []);
        }
        conversations.get(convId).push(message);

        // Envia para o destinatário
        io.to(to).emit('dm:receive', message);
        socket.emit('dm:sent', message);
        
        console.log(`[DM] ${sender?.name} -> ${to}: ${type === 'audio' ? '[Áudio]' : text}`);
    });

    socket.on('dm:typing', (data) => {
        const { to } = data;
        const user = users.get(socket.id);
        io.to(to).emit('dm:typing', {
            from: socket.id,
            name: user?.name
        });
    });

    socket.on('dm:history', (data) => {
        const { with: otherId } = data;
        const convId = [socket.id, otherId].sort().join('-');
        const messages = conversations.get(convId) || [];
        socket.emit('dm:history', messages);
    });

    // ----------------------------------------
    // Servidores
    // ----------------------------------------

    socket.on('server:create', async (data) => {
        try {
            const { name, description } = data;
            const user = users.get(socket.id);

            const result = await pool.query(
                'INSERT INTO servers (name, owner_id, description) VALUES ($1, $2, $3) RETURNING *',
                [name, user?.userId, description]
            );

            const serverId = result.rows[0].id;

            // Adicionar owner como membro
            await pool.query(
                'INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3)',
                [serverId, user?.userId, 'owner']
            );

            // Criar canal padrão
            await pool.query(
                'INSERT INTO channels (server_id, name, type) VALUES ($1, $2, $3)',
                [serverId, 'geral', 'text']
            );

            const server = {
                id: serverId,
                name: result.rows[0].name,
                ownerId: user?.userId,
                ownerName: user?.name,
                members: 1
            };

            socket.emit('server:created', server);
            io.emit('server:new', server);

            console.log(`[SERVER] ${user?.name} criou servidor: ${name}`);
        } catch (error) {
            console.error('[SERVER] Erro ao criar:', error);
            socket.emit('server:error', { message: 'Erro ao criar servidor' });
        }
    });

    socket.on('server:join', async (data) => {
        try {
            const { serverId } = data;
            const user = users.get(socket.id);

            // Verificar se já é membro
            const checkResult = await pool.query(
                'SELECT * FROM server_members WHERE server_id = $1 AND user_id = $2',
                [serverId, user?.userId]
            );

            if (checkResult.rows.length > 0) {
                socket.emit('server:joined', { serverId });
                return;
            }

            // Adicionar como membro
            await pool.query(
                'INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3)',
                [serverId, user?.userId, 'member']
            );

            socket.emit('server:joined', { serverId });
            io.emit('server:member-joined', { serverId, userId: user?.userId, userName: user?.name });

            console.log(`[SERVER] ${user?.name} entrou no servidor: ${serverId}`);
        } catch (error) {
            console.error('[SERVER] Erro ao entrar:', error);
            socket.emit('server:error', { message: 'Erro ao entrar no servidor' });
        }
    });

    socket.on('server:list', async (data) => {
        try {
            const { userId } = data;
            const result = await pool.query(`
                SELECT s.*, COUNT(sm.id) as members FROM servers s
                LEFT JOIN server_members sm ON s.id = sm.server_id
                WHERE EXISTS (
                    SELECT 1 FROM server_members WHERE server_id = s.id AND user_id = $1
                )
                GROUP BY s.id
            `, [userId]);

            socket.emit('server:list', { servers: result.rows });
        } catch (error) {
            console.error('[SERVER] Erro ao listar:', error);
        }
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

async function startServer() {
    try {
        await initializeDatabase();
        
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
    } catch (error) {
        console.error('Erro ao iniciar servidor:', error);
        process.exit(1);
    }
}

startServer();
