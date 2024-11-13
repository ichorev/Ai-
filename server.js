const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const OpenAI = require('openai');

const app = express();

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false
}));
app.use(compression());
app.use(cors());
app.use(cookieParser());

// Check for API key
if (!process.env.Apikey) {
    console.error('ERROR: Apikey environment variable is missing');
    process.exit(1);
}

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.Apikey.trim()
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Data file path
const DATA_FILE = 'data.json';

// Load data
function loadData() {
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
                        description: "Premium user code"
                    },
                    "VIP100": {
                        uses: 100,
                        tier: "VIP",
                        description: "VIP user access"
                    },
                    "UNLIMITED": {
                        uses: "Infinity",
                        tier: "ULTIMATE",
                        description: "Unlimited access"
                    }
                },
                game_stats: {},
                system_config: {
                    max_chat_history: 50,
                    score_thresholds: {
                        BRONZE: 100,
                        SILVER: 250,
                        GOLD: 500,
                        PLATINUM: 1000
                    },
                    rewards: {
                        BRONZE: 5,
                        SILVER: 15,
                        GOLD: 30,
                        PLATINUM: 50
                    }
                }
            };
            fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
            return initialData;
        }
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (error) {
        console.error('Error loading data:', error);
        return { users: {}, access_codes: {}, game_stats: {} };
    }
}

// Save data
function saveData(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error saving data:', error);
    }
}

// Keep data in memory
let gameData = loadData();

// Authentication middleware
function requireAuth(req, res, next) {
    if (!req.session.username) {
        return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    next();
}

// Rate limiting
const rateLimit = new Map();
const RATE_LIMIT = 50; // requests per minute
const RATE_WINDOW = 60000; // 1 minute in milliseconds

function checkRateLimit(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    const userRate = rateLimit.get(ip) || { count: 0, reset: now + RATE_WINDOW };

    if (now > userRate.reset) {
        userRate.count = 1;
        userRate.reset = now + RATE_WINDOW;
    } else if (userRate.count >= RATE_LIMIT) {
        return res.status(429).json({ error: 'Too many requests, please try again later' });
    } else {
        userRate.count++;
    }

    rateLimit.set(ip, userRate);
    next();
}

// Routes
app.get('/', checkRateLimit, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/register', checkRateLimit, async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.json({ success: false, error: 'Missing username or password' });
    }

    if (gameData.users[username]) {
        return res.json({ success: false, error: 'Username already exists' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        gameData.users[username] = {
            password: hashedPassword,
            created: Date.now(),
            lastLogin: null,
            chatHistory: [],
            accessCodes: ['TEST5'],
            gameScore: 0,
            usesRemaining: 5,
            rewards: []
        };
        saveData(gameData);
        res.json({ success: true });
    } catch (error) {
        console.error('Registration error:', error);
        res.json({ success: false, error: 'Registration failed' });
    }
});

app.post('/login', checkRateLimit, async (req, res) => {
    const { username, password } = req.body;
    const user = gameData.users[username];

    if (!user) {
        return res.json({ success: false, error: 'Invalid username or password' });
    }

    try {
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.json({ success: false, error: 'Invalid username or password' });
        }

        user.lastLogin = Date.now();
        gameData.users[username] = user;
        saveData(gameData);

        req.session.username = username;
        res.json({
            success: true,
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
    gameData.users[username].lastLogin = Date.now();
    saveData(gameData);
    req.session.destroy();
    res.json({ success: true });
});

app.get('/check-auth', (req, res) => {
    if (req.session.username) {
        const user = gameData.users[req.session.username];
        res.json({
            authenticated: true,
            username: req.session.username,
            usesRemaining: user.usesRemaining,
            gameScore: user.gameScore
        });
    } else {
        res.json({ authenticated: false });
    }
});

app.post('/chat', requireAuth, checkRateLimit, async (req, res) => {
    const user = gameData.users[req.session.username];
    
    if (user.usesRemaining <= 0) {
        return res.json({ success: false, error: 'No uses remaining. Play games to earn more!' });
    }

    const { message } = req.body;

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4-0125-preview",
            messages: [{ role: "user", content: message }],
            max_tokens: 4000,
            temperature: 0.7,
        });

        user.usesRemaining--;
        user.chatHistory.push({
            timestamp: Date.now(),
            message,
            response: completion.choices[0].message.content,
            usesLeft: user.usesRemaining
        });

        // Limit chat history size
        if (user.chatHistory.length > gameData.system_config.max_chat_history) {
            user.chatHistory = user.chatHistory.slice(-gameData.system_config.max_chat_history);
        }

        gameData.users[req.session.username] = user;
        saveData(gameData);

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

app.post('/game-score', requireAuth, checkRateLimit, (req, res) => {
    const { score } = req.body;
    const username = req.session.username;
    const user = gameData.users[username];
    const thresholds = gameData.system_config.score_thresholds;
    const rewards = gameData.system_config.rewards;

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
    Object.entries(thresholds).forEach(([tier, threshold]) => {
        if (score >= threshold && !user.rewards.includes(tier)) {
            user.rewards.push(tier);
            user.usesRemaining += rewards[tier];
            stats.rewards.push({
                tier,
                score,
                earned: Date.now(),
                usesAwarded: rewards[tier]
            });
        }
    });

    gameData.users[username] = user;
    gameData.game_stats[username] = stats;
    saveData(gameData);

    res.json({
        success: true,
        gameScore: user.gameScore,
        usesRemaining: user.usesRemaining,
        highScore: stats.highScore
    });
});

app.post('/redeem-code', requireAuth, checkRateLimit, (req, res) => {
    const { code } = req.body;
    const username = req.session.username;
    const user = gameData.users[username];

    if (!gameData.access_codes[code]) {
        return res.json({ success: false, error: 'Invalid access code' });
    }

    if (user.accessCodes.includes(code)) {
        return res.json({ success: false, error: 'Code already used' });
    }

    const codeData = gameData.access_codes[code];
    user.accessCodes.push(code);

    // Handle unlimited uses
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

app.get('/user-stats', requireAuth, (req, res) => {
    const username = req.session.username;
    const user = gameData.users[username];
    const stats = gameData.game_stats[username] || {
        highScore: 0,
        totalGames: 0,
        rewards: []
    };

    res.json({
        success: true,
        stats: {
            usesRemaining: user.usesRemaining,
            gameScore: user.gameScore,
            highScore: stats.highScore,
            totalGames: stats.totalGames,
            rewards: stats.rewards,
            chatHistory: user.chatHistory.length,
            accessCodes: user.accessCodes
        }
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('API Key:', process.env.Apikey ? 'Present' : 'Missing');
    console.log('Environment:', process.env.NODE_ENV || 'development');
});

// Handle shutdown gracefully
process.on('SIGTERM', () => {
    console.log('Received SIGTERM. Saving data and shutting down...');
    saveData(gameData);
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    saveData(gameData);
    process.exit(1);
});
