require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { randomBytes, createHash } = require('crypto');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const moment = require('moment');
const app = express();

// Import OpenAI
const OpenAI = require('openai');

// Check for API key
if (!process.env.Apikey) {
    console.error('ERROR: Apikey environment variable is missing');
    process.exit(1);
}

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.Apikey.trim()
});

// Enhanced security middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// File paths and data directories
const DATA_DIR = 'data';
const BACKUP_DIR = 'backups';
const USERS_FILE = `${DATA_DIR}/users.json`;
const CHAT_LOGS_FILE = `${DATA_DIR}/chat_logs.json`;
const GAME_DATA_FILE = `${DATA_DIR}/game_data.json`;

// Create necessary directories
[DATA_DIR, BACKUP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
    }
});

// Data storage
let users = new Map();
let chatLogs = new Map();
let gameData = new Map();

// Access code configuration
const ACCESS_CODES = {
    'TEST5': { uses: 5, tier: 'BASIC' },
    'PREMIUM50': { uses: 50, tier: 'PREMIUM' },
    'VIP100': { uses: 100, tier: 'VIP' }
};

// Game reward tiers
const REWARD_TIERS = {
    BRONZE: { score: 100, reward: 5 },
    SILVER: { score: 250, reward: 15 },
    GOLD: { score: 500, reward: 30 },
    PLATINUM: { score: 1000, reward: 50 }
};

// Data management functions
function loadData() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            users = new Map(Object.entries(JSON.parse(fs.readFileSync(USERS_FILE))));
        }
        if (fs.existsSync(CHAT_LOGS_FILE)) {
            chatLogs = new Map(Object.entries(JSON.parse(fs.readFileSync(CHAT_LOGS_FILE))));
        }
        if (fs.existsSync(GAME_DATA_FILE)) {
            gameData = new Map(Object.entries(JSON.parse(fs.readFileSync(GAME_DATA_FILE))));
        }
    } catch (error) {
        console.error('Error loading data:', error);
        createBackup(); // Create backup if data is corrupted
    }
}

function saveData() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(Object.fromEntries(users)));
        fs.writeFileSync(CHAT_LOGS_FILE, JSON.stringify(Object.fromEntries(chatLogs)));
        fs.writeFileSync(GAME_DATA_FILE, JSON.stringify(Object.fromEntries(gameData)));
        createBackup();
    } catch (error) {
        console.error('Error saving data:', error);
    }
}

function createBackup() {
    const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss');
    const backupPath = path.join(BACKUP_DIR, `backup_${timestamp}`);
    
    try {
        if (!fs.existsSync(BACKUP_DIR)) {
            fs.mkdirSync(BACKUP_DIR);
        }
        
        fs.writeFileSync(`${backupPath}_users.json`, JSON.stringify(Object.fromEntries(users)));
        fs.writeFileSync(`${backupPath}_chats.json`, JSON.stringify(Object.fromEntries(chatLogs)));
        fs.writeFileSync(`${backupPath}_game.json`, JSON.stringify(Object.fromEntries(gameData)));
        
        // Keep only last 5 backups
        const backups = fs.readdirSync(BACKUP_DIR);
        if (backups.length > 15) {
            backups.slice(0, -15).forEach(backup => {
                fs.unlinkSync(path.join(BACKUP_DIR, backup));
            });
        }
    } catch (error) {
        console.error('Backup creation failed:', error);
    }
}

// User management functions
function createUser(username, hashedPassword) {
    const userData = {
        password: hashedPassword,
        created: Date.now(),
        lastLogin: null,
        chatHistory: [],
        accessCodes: ['TEST5'],
        gameScore: 0,
        usesRemaining: 5,
        totalChats: 0,
        rewards: [],
        settings: {
            theme: 'light',
            notifications: true
        }
    };
    users.set(username, userData);
    saveData();
    return userData;
}

function updateUserData(username, updates) {
    const user = users.get(username);
    if (user) {
        Object.assign(user, updates);
        users.set(username, user);
        saveData();
    }
}

// Initialize data
loadData();

// Authentication middleware
function requireAuth(req, res, next) {
    if (!req.session.username) {
        return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    next();
}

// Rate limiting
const rateLimit = new Map();
function checkRateLimit(req, res, next) {
    const key = req.ip + (req.session.username || '');
    const now = Date.now();
    const limit = rateLimit.get(key) || { count: 0, reset: now + 60000 };

    if (now > limit.reset) {
        limit.count = 1;
        limit.reset = now + 60000;
    } else if (limit.count > 50) {
        return res.status(429).json({ error: 'Too many requests' });
    } else {
        limit.count++;
    }

    rateLimit.set(key, limit);
    next();
}

app.use(checkRateLimit);

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.json({ success: false, error: 'Missing username or password' });
    }

    if (users.has(username)) {
        return res.json({ success: false, error: 'Username already exists' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const userData = createUser(username, hashedPassword);
        res.json({ success: true });
    } catch (error) {
        console.error('Registration error:', error);
        res.json({ success: false, error: 'Registration failed' });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.get(username);

    if (!user) {
        return res.json({ success: false, error: 'Invalid username or password' });
    }

    try {
        const validPassword = await bcrypt.hash(password, 10);
        if (!validPassword) {
            return res.json({ success: false, error: 'Invalid username or password' });
        }

        user.lastLogin = Date.now();
        updateUserData(username, { lastLogin: Date.now() });

        req.session.username = username;
        res.json({
            success: true,
            username,
            usesRemaining: user.usesRemaining,
            gameScore: user.gameScore,
            settings: user.settings
        });
    } catch (error) {
        console.error('Login error:', error);
        res.json({ success: false, error: 'Login failed' });
    }
});

app.post('/logout', (req, res) => {
    const username = req.session.username;
    if (username) {
        updateUserData(username, { lastLogout: Date.now() });
    }
    req.session.destroy();
    res.json({ success: true });
});

app.get('/user-data', requireAuth, (req, res) => {
    const user = users.get(req.session.username);
    if (user) {
        const { password, ...userData } = user;
        res.json({ success: true, data: userData });
    } else {
        res.json({ success: false, error: 'User not found' });
    }
});

app.post('/chat', requireAuth, async (req, res) => {
    const { message } = req.body;
    const username = req.session.username;
    const user = users.get(username);

    if (user.usesRemaining <= 0) {
        return res.json({ success: false, error: 'No uses remaining' });
    }

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4-0125-preview",
            messages: [{ role: "user", content: message }],
            max_tokens: 4000,
            temperature: 0.7,
        });

        const response = completion.choices[0].message.content;

        // Update user data
        user.usesRemaining--;
        user.totalChats++;
        user.chatHistory.push({
            timestamp: Date.now(),
            message,
            response,
            usesLeft: user.usesRemaining
        });

        // Limit chat history
        if (user.chatHistory.length > 50) {
            user.chatHistory = user.chatHistory.slice(-50);
        }

        updateUserData(username, user);

        // Log chat
        const chatLog = chatLogs.get(username) || [];
        chatLog.push({
            timestamp: Date.now(),
            message,
            response,
            usesLeft: user.usesRemaining
        });
        chatLogs.set(username, chatLog);
        saveData();

        res.json({
            success: true,
            response,
            usesRemaining: user.usesRemaining
        });
    } catch (error) {
        console.error('Chat error:', error);
        res.json({ success: false, error: 'Failed to get response' });
    }
});

app.post('/game-score', requireAuth, (req, res) => {
    const { score } = req.body;
    const username = req.session.username;
    const user = users.get(username);

    user.gameScore += score;

    // Check for rewards
    for (const [tier, data] of Object.entries(REWARD_TIERS)) {
        if (user.gameScore >= data.score && 
            !user.rewards.includes(tier)) {
            user.rewards.push(tier);
            user.usesRemaining += data.reward;
        }
    }

    updateUserData(username, user);

    res.json({
        success: true,
        gameScore: user.gameScore,
        usesRemaining: user.usesRemaining,
        rewards: user.rewards
    });
});

app.post('/redeem-code', requireAuth, (req, res) => {
    const { code } = req.body;
    const username = req.session.username;
    const user = users.get(username);

    if (!ACCESS_CODES[code]) {
        return res.json({ success: false, error: 'Invalid code' });
    }

    if (user.accessCodes.includes(code)) {
        return res.json({ success: false, error: 'Code already used' });
    }

    user.accessCodes.push(code);
    user.usesRemaining += ACCESS_CODES[code].uses;

    updateUserData(username, user);

    res.json({
        success: true,
        usesRemaining: user.usesRemaining,
        message: `Added ${ACCESS_CODES[code].uses} uses`
    });
});

app.post('/update-settings', requireAuth, (req, res) => {
    const { settings } = req.body;
    const username = req.session.username;
    const user = users.get(username);

    user.settings = { ...user.settings, ...settings };
    updateUserData(username, user);

    res.json({ success: true, settings: user.settings });
});

// Error handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// Automatic backup every hour
setInterval(createBackup, 3600000);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('API Key:', process.env.Apikey ? 'Present' : 'Missing');
    console.log('Environment:', process.env.NODE_ENV || 'development');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM. Saving data and shutting down...');
    saveData();
    process.exit(0);
});
