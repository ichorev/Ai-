const express = require('express');
const path = require('path');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;

// Import OpenAI
const OpenAI = require('openai');

const app = express();

// Check for API key
if (!process.env.Apikey) {
    console.error('ERROR: Apikey environment variable is missing');
    process.exit(1);
}

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.Apikey.trim()
});

// Enhanced Security Middleware
app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: false
}));
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    trustProxy: true,
    handler: (req, res) => {
        res.status(429).json({
            success: false,
            error: 'Too many requests, please try again later.'
        });
    }
});

app.use(limiter);

// Session configuration
app.use(session({
    secret: process.env.Apikey || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Data file path
const DATA_FILE = 'data.json';
let gameData = null;

// Constants
const GAME_CONFIG = {
    REWARD_THRESHOLDS: {
        BRONZE: { score: 100, uses: 5 },
        SILVER: { score: 250, uses: 15 },
        GOLD: { score: 500, uses: 30 },
        PLATINUM: { score: 1000, uses: 50 }
    },
    MAX_HISTORY: 50,
    BACKUP_INTERVAL: 3600000 // 1 hour
};

// Load data with error handling
async function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            const initialData = {
                users: {},
                access_codes: {
                    "TEST5": {
                        uses: 5,
                        tier: "BASIC",
                        description: "Trial access code"
                    },
                    "PREMIUM50": {
                        uses: 50,
                        tier: "PREMIUM",
                        description: "Premium access"
                    },
                    "VIP100": {
                        uses: 100,
                        tier: "VIP",
                        description: "VIP access"
                    },
                    "UNLIMITED": {
                        uses: "Infinity",
                        tier: "ULTIMATE",
                        description: "Unlimited access"
                    }
                },
                game_stats: {},
                system_config: {
                    max_chat_history: GAME_CONFIG.MAX_HISTORY,
                    score_thresholds: GAME_CONFIG.REWARD_THRESHOLDS
                }
            };
            await fs.writeFile(DATA_FILE, JSON.stringify(initialData, null, 2));
            return initialData;
        }
        const data = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
        await createBackup(data);
        return data;
    } catch (error) {
        console.error('Error loading data:', error);
        const backup = await loadLatestBackup();
        if (backup) {
            console.log('Loaded data from backup');
            return backup;
        }
        return { users: {}, access_codes: {}, game_stats: {} };
    }
}

// Save data with backup
async function saveData(data) {
    try {
        await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
        await createBackup(data);
    } catch (error) {
        console.error('Error saving data:', error);
    }
}

// Backup management
async function createBackup(data) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = 'backups';
    const backupPath = path.join(backupDir, `backup_${timestamp}.json`);

    try {
        if (!fs.existsSync(backupDir)) {
            await fs.mkdir(backupDir);
        }

        await fs.writeFile(backupPath, JSON.stringify(data, null, 2));

        // Keep only last 24 backups
        const backups = await fs.readdir(backupDir);
        const sortedBackups = backups
            .filter(file => file.startsWith('backup_'))
            .sort()
            .reverse();

        if (sortedBackups.length > 24) {
            for (const backup of sortedBackups.slice(24)) {
                await fs.unlink(path.join(backupDir, backup));
            }
        }
    } catch (error) {
        console.error('Backup creation failed:', error);
    }
}

// Load latest backup
async function loadLatestBackup() {
    try {
        const backupDir = 'backups';
        if (!fs.existsSync(backupDir)) return null;

        const backups = await fs.readdir(backupDir);
        const sortedBackups = backups
            .filter(file => file.startsWith('backup_'))
            .sort()
            .reverse();

        if (sortedBackups.length === 0) return null;

        const latestBackup = await fs.readFile(
            path.join(backupDir, sortedBackups[0]), 
            'utf8'
        );
        return JSON.parse(latestBackup);
    } catch (error) {
        console.error('Error loading backup:', error);
        return null;
    }
}

// Initialize game data
gameData = await loadData();

// User verification middleware
function requireAuth(req, res, next) {
    if (!req.session.username) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    next();
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Authentication routes
app.post('/register', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.json({ success: false, error: 'Missing username or password' });
    }

    if (username.length < 3 || username.length > 20) {
        return res.json({ success: false, error: 'Username must be between 3 and 20 characters' });
    }

    if (password.length < 6) {
        return res.json({ success: false, error: 'Password must be at least 6 characters' });
    }

    if (gameData.users[username]) {
        return res.json({ success: false, error: 'Username already exists' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        gameData.users[username] = {
            id: uuidv4(),
            password: hashedPassword,
            created: Date.now(),
            lastLogin: null,
            chatHistory: [],
            accessCodes: ['TEST5'],
            gameScore: 0,
            usesRemaining: 5,
            rewards: []
        };
        
        await saveData(gameData);
        res.json({ success: true });
    } catch (error) {
        console.error('Registration error:', error);
        res.json({ success: false, error: 'Registration failed' });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = gameData.users[username];

    if (!user) {
        return res.json({ success: false, error: 'Invalid username or password' });
    }

    try {
        const validPassword = await bcrypt.hash(password, 10);
        if (!validPassword) {
            return res.json({ success: false, error: 'Invalid username or password' });
        }

        user.lastLogin = Date.now();
        gameData.users[username] = user;
        await saveData(gameData);

        req.session.username = username;
        res.json({
            success: true,
            username,
            usesRemaining: user.usesRemaining,
            gameScore: user.gameScore
        });
    } catch (error) {
        console.error('Login error:', error);
        res.json({ success: false, error: 'Login failed' });
    }
});

app.post('/logout', requireAuth, (req, res) => {
    const username = req.session.username;
    if (username) {
        gameData.users[username].lastLogin = Date.now();
        saveData(gameData);
    }
    req.session.destroy();
    res.json({ success: true });
});

// Chat routes
app.post('/chat', requireAuth, async (req, res) => {
    const username = req.session.username;
    const user = gameData.users[username];
    
    if (!user) {
        return res.json({ success: false, error: 'User not found' });
    }

    if (user.usesRemaining <= 0) {
        return res.json({ 
            success: false, 
            error: 'No uses remaining. Play games to earn more!' 
        });
    }

    const { message } = req.body;

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4-0125-preview",
            messages: [{ role: "user", content: message }],
            max_tokens: 4000,
            temperature: 0.7,
        });

        // Update user data
        user.usesRemaining--;
        user.chatHistory.push({
            timestamp: Date.now(),
            message,
            response: completion.choices[0].message.content,
            usesLeft: user.usesRemaining
        });

        // Limit chat history
        if (user.chatHistory.length > GAME_CONFIG.MAX_HISTORY) {
            user.chatHistory = user.chatHistory.slice(-GAME_CONFIG.MAX_HISTORY);
        }

        gameData.users[username] = user;
        await saveData(gameData);

        res.json({
            success: true,
            response: completion.choices[0].message.content,
            usesRemaining: user.usesRemaining
        });
    } catch (error) {
        console.error('Chat error:', error);
        res.json({ success: false, error: 'Failed to get AI response' });
    }
});

// Game routes
app.post('/game-score', requireAuth, async (req, res) => {
    const { score } = req.body;
    const username = req.session.username;
    const user = gameData.users[username];

    if (!user) {
        return res.json({ success: false, error: 'User not found' });
    }

    // Update game stats
    if (!gameData.game_stats[username]) {
        gameData.game_stats[username] = {
            highScore: 0,
            totalGames: 0,
            rewards: []
        };
    }

    const stats = gameData.game_stats[username];
    stats.totalGames++;
    
    if (score > stats.highScore) {
        stats.highScore = score;
    }

    user.gameScore += score;

    // Check for rewards
    let rewardEarned = false;
    Object.entries(GAME_CONFIG.REWARD_THRESHOLDS).forEach(([tier, data]) => {
        if (score >= data.score && !user.rewards.includes(tier)) {
            user.rewards.push(tier);
            user.usesRemaining += data.uses;
            stats.rewards.push({
                tier,
                score,
                earned: Date.now(),
                uses: data.uses
            });
            rewardEarned = true;
        }
    });

    gameData.users[username] = user;
    gameData.game_stats[username] = stats;
    await saveData(gameData);

    res.json({
        success: true,
        gameScore: user.gameScore,
        highScore: stats.highScore,
        rewardEarned,
        usesRemaining: user.usesRemaining
    });
});

// Code redemption
app.post('/redeem-code', requireAuth, (req, res) => {
    const { code } = req.body;
    const username = req.session.username;
    const user = gameData.users[username];

    if (!user) {
        return res.json({ success: false, error: 'User not found' });
    }

    if (!gameData.access_codes[code]) {
        return res.json({ success: false, error: 'Invalid code' });
    }

    if (user.accessCodes.includes(code)) {
        return res.json({ success: false, error: 'Code already used' });
    }

    const codeData = gameData.access_codes[code];
    user.accessCodes.push(code);
    
    if (codeData.uses === "Infinity") {
        user.usesRemaining = Infinity;
    } else {
        user.usesRemaining += parseInt(codeData.uses);
    }

    gameData.users[username] = user;
    saveData(gameData);

    res.json({
        success: true,
        usesRemaining: user.usesRemaining,
        message: `Added ${codeData.uses} uses`
    });
});

// User data route
app.get('/user-data', requireAuth, (req, res) => {
    const username = req.session.username;
    const user = gameData.users[username];
    
    if (!user) {
        return res.json({ success: false, error: 'User not found' });
    }

    const stats = gameData.game_stats[username] || {
        highScore: 0,
        totalGames: 0,
        rewards: []
    };

    res.json({
        success: true,
        userData: {
            usesRemaining: user.usesRemaining,
            gameScore: user.gameScore,
            chatHistory: user.chatHistory,
            accessCodes: user.accessCodes,
            rewards: user.rewards
        },
        gameStats: stats
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err.stack);
    res.status(500).json({
        success: false,
        error: 'An internal server error occurred'
    });
});

// Automatic backup every hour
setInterval(() => {
    if (gameData) {
        createBackup(gameData);
    }
}, GAME_CONFIG.BACKUP_INTERVAL);

// Start server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('API Key:', process.env.Apikey ? 'Present' : 'Missing');
    console.log('Environment:', process.env.NODE_ENV || 'development');console.log('Data file:', DATA_FILE);
});

// Cleanup routine for old sessions and expired data
setInterval(() => {
    try {
        const now = Date.now();
        Object.entries(gameData.users).forEach(([username, user]) => {
            // Clean up old chat history
            if (user.chatHistory) {
                user.chatHistory = user.chatHistory.filter(chat => 
                    (now - chat.timestamp) < (30 * 24 * 60 * 60 * 1000) // 30 days
                );
            }

            // Reset daily stats if needed
            if (user.lastLogin) {
                const lastLoginDate = new Date(user.lastLogin).setHours(0, 0, 0, 0);
                const today = new Date().setHours(0, 0, 0, 0);
                if (lastLoginDate < today) {
                    user.dailyUses = 0;
                }
            }

            gameData.users[username] = user;
        });

        saveData(gameData);
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}, 24 * 60 * 60 * 1000); // Run daily

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: Date.now(),
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        dataFileSize: fs.statSync(DATA_FILE).size
    });
});

// Graceful shutdown handlers
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    server.close(async () => {
        console.log('Server closed. Saving final data...');
        if (gameData) {
            await saveData(gameData);
            await createBackup(gameData);
        }
        process.exit(0);
    });

    // Force exit if graceful shutdown fails
    setTimeout(() => {
        console.log('Forcing shutdown after timeout');
        process.exit(1);
    }, 10000).unref();
});

process.on('SIGINT', () => {
    console.log('SIGINT received. Shutting down gracefully...');
    server.close(async () => {
        console.log('Server closed. Saving final data...');
        if (gameData) {
            await saveData(gameData);
            await createBackup(gameData);
        }
        process.exit(0);
    });
});

// Uncaught exception handler
process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error);
    if (gameData) {
        await saveData(gameData);
        await createBackup(gameData);
    }
    process.exit(1);
});

// Unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = app;
