const { Pool } = require('pg');
require('dotenv').config();

let pool;
let isConnected = false;

try {
    // Se DATABASE_URL existe (Railway), usar diretamente
    // Caso contrário, usar variáveis individuais
    const databaseUrl = process.env.DATABASE_URL;
    
    if (databaseUrl) {
        // Railway fornece DATABASE_URL
        pool = new Pool({
            connectionString: databaseUrl,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
        });
    } else {
        // Modo desenvolvimento com credenciais separadas
        pool = new Pool({
            user: process.env.DB_USER || 'postgres',
            password: process.env.DB_PASSWORD || '',
            host: process.env.DB_HOST || 'localhost',
            port: process.env.DB_PORT || 5432,
            database: process.env.DB_NAME || 'abyss_connect',
            ssl: false,
            max: 10,
            idleTimeoutMillis: 10000,
            connectionTimeoutMillis: 2000,
        });
    }

    // Testa conexão com timeout
    const testConnection = async () => {
        try {
            const result = await pool.query('SELECT NOW()');
            console.log('[DB] ✅ Conectado ao PostgreSQL:', result.rows[0]);
            isConnected = true;
        } catch (error) {
            console.warn('[DB] ⚠️  PostgreSQL não disponível, modo em memória');
            isConnected = false;
        }
    };

    pool.on('connect', () => {
        console.log('[DB] Nova conexão estabelecida');
    });

    pool.on('error', (err) => {
        console.warn('[DB] Aviso de conexão:', err.message);
        isConnected = false;
    });

    // Teste inicial
    testConnection().catch(err => {
        console.warn('[DB] Erro no teste inicial:', err.message);
    });

} catch (error) {
    console.warn('[DB] ⚠️  Não foi possível criar pool PostgreSQL:', error.message);
    isConnected = false;
}

// Inicializar banco de dados
async function initializeDatabase() {
    // Se não há PostgreSQL, pular inicialização
    if (!pool || !isConnected) {
        console.log('[DB] PostgreSQL não disponível - modo em memória');
        return;
    }

    try {
        // Tabela de usuários
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                avatar TEXT,
                status VARCHAR(20) DEFAULT 'online',
                bio TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabela de servidores
        await pool.query(`
            CREATE TABLE IF NOT EXISTS servers (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name VARCHAR(100) NOT NULL,
                owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                icon TEXT,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(name, owner_id)
            )
        `);

        // Tabela de membros do servidor
        await pool.query(`
            CREATE TABLE IF NOT EXISTS server_members (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role VARCHAR(20) DEFAULT 'member',
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(server_id, user_id)
            )
        `);

        // Tabela de canais
        await pool.query(`
            CREATE TABLE IF NOT EXISTS channels (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                name VARCHAR(100) NOT NULL,
                type VARCHAR(20) DEFAULT 'text',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabela de mensagens
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                message_type VARCHAR(20) DEFAULT 'text',
                audio_data TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabela de DMs
        await pool.query(`
            CREATE TABLE IF NOT EXISTS direct_messages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                message_type VARCHAR(20) DEFAULT 'text',
                audio_data TEXT,
                read BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Índices para melhor performance
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_server_members_server_id ON server_members(server_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_server_members_user_id ON server_members(user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_channels_server_id ON channels(server_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_direct_messages_users ON direct_messages(from_user_id, to_user_id)`);

        console.log('[DB] Tabelas criadas com sucesso');
    } catch (error) {
        if (isConnected) {
            console.error('[DB] Erro ao inicializar banco:', error.message);
        }
    }
}

module.exports = { pool, initializeDatabase, isConnected: () => isConnected };
