# Abyss Connect Server

Backend do Abyss Connect para deploy no Railway.

## The Abyss Team
- **Líder:** Raul Pereira Leite
- **CPF:** 423.135.168-65

---

## Funcionalidades

- **WebSocket (Socket.IO)** - Comunicação em tempo real
- **Mensagens** - Chat com texto e áudio
- **Chat de Voz** - Salas com WebRTC signaling
- **Transmissão de Tela** - Streaming com WebRTC
- **Presença** - Status online/offline dos usuários

---

## Deploy no Railway

### Opção 1: Via GitHub

1. Faça push deste diretório `server/` para um repositório GitHub separado
2. Acesse [railway.app](https://railway.app)
3. Clique em **New Project** → **Deploy from GitHub repo**
4. Selecione o repositório
5. Railway detectará automaticamente o Node.js e fará o deploy

### Opção 2: Via Railway CLI

```bash
# Instalar CLI
npm install -g @railway/cli

# Login
railway login

# Criar projeto
railway init

# Deploy
railway up
```

### Opção 3: Via Template

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new)

---

## Variáveis de Ambiente

Configure no Railway Dashboard → Variables:

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `PORT` | Porta do servidor | Definido pelo Railway |
| `NODE_ENV` | Ambiente | `production` |
| `CLIENT_ORIGIN` | CORS origem permitida | `*` |

---

## Endpoints HTTP

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/` | Info do servidor |
| GET | `/health` | Health check |
| GET | `/stats` | Estatísticas |

---

## Eventos Socket.IO

### Usuários
- `user:login` - Login do usuário
- `user:update` - Atualizar perfil
- `user:status` - Mudar status
- `users:list` - Lista de usuários online

### Mensagens
- `message:send` - Enviar mensagem
- `message:receive` - Receber mensagem
- `message:typing` - Indicador de digitação
- `messages:history` - Histórico de conversa

### Chat de Voz
- `voice:join` - Entrar em sala
- `voice:leave` - Sair de sala
- `voice:create-room` - Criar sala
- `voice:offer/answer/ice-candidate` - WebRTC signaling
- `voice:speaking` - Indicador de fala

### Transmissão
- `stream:start` - Iniciar transmissão
- `stream:stop` - Parar transmissão
- `stream:watch` - Assistir transmissão
- `stream:list` - Listar transmissões ativas

---

## Desenvolvimento Local

```bash
# Instalar dependências
npm install

# Copiar variáveis de ambiente
cp .env.example .env

# Executar em desenvolvimento
npm run dev

# Executar em produção
npm start
```

---

## Conectando o Cliente

No app Electron, atualize a conexão Socket.IO:

```javascript
// src/renderer/js/app.js
const socket = io('https://seu-app.railway.app');

socket.on('connect', () => {
    socket.emit('user:login', {
        name: 'Seu Nome',
        avatar: 'url-do-avatar'
    });
});
```

---

## Estrutura

```
server/
├── src/
│   └── server.js      # Servidor principal
├── package.json       # Dependências
├── railway.json       # Config Railway
├── Procfile           # Comando de start
├── .env.example       # Variáveis exemplo
└── .gitignore
```

---

## Licença

Copyright © 2024 The Abyss Team. Todos os direitos reservados.
