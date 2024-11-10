const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { randomBytes, createHash } = require('crypto');
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

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// File paths
const USERS_FILE = 'data/users.json';
const CHAT_DATA_FILE = 'data/chat_data.json';
const GAME_DATA_FILE = 'data/game_data.json';

// Ensure data directory exists
if (!fs.existsSync('data')){
    fs.mkdirSync('data');
}

// Data storage
let users = new Map();
let chatData = new Map();
let gameData = new Map();

// Access codes configuration
const ACCESS_CODES = {
    'TEST5': { uses: 5, tier: 'BASIC' },
    'PREMIUM50': { uses: 50, tier: 'PREMIUM' },
    'UNLIMITED100': { uses: 100, tier: 'VIP' }
};

// Game reward tiers
const REWARD_TIERS = {
    BRONZE: { score: 100, uses: 10 },
    SILVER: { score: 250, uses: 25 },
    GOLD: { score: 500, uses: 50 },
    PLATINUM: { score: 1000, uses: 100 }
};

// Load data from files
function loadData() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const userData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            users = new Map(Object.entries(userData));
        }
        if (fs.existsSync(CHAT_DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(CHAT_DATA_FILE, 'utf8'));
            chatData = new Map(Object.entries(data));
        }
        if (fs.existsSync(GAME_DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(GAME_DATA_FILE, 'utf8'));
            gameData = new Map(Object.entries(data));
        }
    } catch (error) {
        console.error('Error loading data:', error);
    }
}

// Save data to files
function saveData() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(Object.fromEntries(users)));
        fs.writeFileSync(CHAT_DATA_FILE, JSON.stringify(Object.fromEntries(chatData)));
        fs.writeFileSync(GAME_DATA_FILE, JSON.stringify(Object.fromEntries(gameData)));
    } catch (error) {
        console.error('Error saving data:', error);
    }
}

// Initialize data
loadData();

// Authentication middleware
function requireLogin(req, res, next) {
    if (!req.session.username) {
        res.status(401).json({ success: false, error: 'Not authenticated' });
        return;
    }
    next();
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;

    if (users.has(username)) {
        return res.json({ success: false, error: 'Username already exists' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        users.set(username, {
            password: hashedPassword,
            created: Date.now(),
            lastLogin: null,
            chatHistory: [],
            accessCodes: [],
            gameScore: 0,
            earnedRewards: []
        });
        saveData();
        res.json({ success: true });
    } catch (error) {
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
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.json({ success: false, error: 'Invalid username or password' });
        }

        user.lastLogin = Date.now();
        users.set(username, user);
        saveData();

        req.session.username = username;
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, error: 'Login failed' });
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/check-auth', (req, res) => {
    res.json({ 
        authenticated: !!req.session.username,
        username: req.session.username 
    });
});

// Chat routes
app.post('/chat', requireLogin, async (req, res) => {
    const { message } = req.body;
    const username = req.session.username;
    const user = users.get(username);

    // Check if user has available uses
    if (!user.accessCodes.some(code => code.remainingUses > 0)) {
        return res.json({ success: false, error: 'No available uses' });
    }

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4-0125-preview",
            messages: [{ role: "user", content: message }],
            max_tokens: 4000,
            temperature: 0.7,
        });

        // Update usage
        for (let code of user.accessCodes) {
            if (code.remainingUses > 0) {
                code.remainingUses--;
                break;
            }
        }

        // Store chat history
        user.chatHistory.push({
            timestamp: Date.now(),
            message,
            response: completion.choices[0].message.content
        });

        // Limit history size
        if (user.chatHistory.length > 100) {
            user.chatHistory = user.chatHistory.slice(-100);
        }

        users.set(username, user);
        saveData();

        res.json({
            success: true,
            response: completion.choices[0].message.content
        });
    } catch (error) {
        console.error('OpenAI API Error:', error);
        res.json({ success: false, error: 'Error communicating with ChatGPT' });
    }
});

// Game routes
app.post('/submit-score', requireLogin, (req, res) => {
    const { score } = req.body;
    const username = req.session.username;
    const user = users.get(username);

    user.gameScore += score;

    // Check for rewards
    for (const [tier, data] of Object.entries(REWARD_TIERS)) {
        if (user.gameScore >= data.score && 
            !user.earnedRewards.some(reward => reward.tier === tier)) {
            
            const reward = {
                tier,
                uses: data.uses,
                remainingUses: data.uses,
                earned: Date.now()
            };
            
            user.earnedRewards.push(reward);
            user.accessCodes.push(reward);
        }
    }

    users.set(username, user);
    saveData();

    res.json({
        success: true,
        totalScore: user.gameScore,
        earnedRewards: user.earnedRewards
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('API Key:', process.env.Apikey ? 'Present' : 'Missing');
});
