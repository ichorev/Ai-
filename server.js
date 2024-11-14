const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const moment = require('moment');

// Import OpenAI
const OpenAI = require('openai');

// Initialize express app
const app = express();

// Enhanced security middleware
app.use(helmet({
    contentSecurityPolicy: false
}));
app.use(compression());
app.use(cors());
app.use(cookieParser());

// Rate limiting
const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

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
    secret: process.env.SESSION_SECRET || 'your-secret-key',
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

// Load data function with error handling and backup
function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            const initialData = {
                users: {},
                access_codes: {
                    "TEST5": {
                        uses: 5,
                        tier: "BASIC",
                        description: "Trial access code",
                        cooldown: 3600000
                    },
                    "PREMIUM50": {
                        uses: 50,
                        tier: "PREMIUM",
                        description: "Premium user code",
                        cooldown: null
                    },
                    "VIP100": {
                        uses: 100,
                        tier: "VIP",
                        description: "VIP user access",
                        cooldown: null
                    },
                    "UNLIMITED": {
                        uses: "Infinity",
                        tier: "ULTIMATE",
                        description: "Unlimited access",
                        cooldown: null
                    }
                },
                game_stats: {},
                system_config: {
                    max_chat_history: 50,
                    score_thresholds: {
                        BRONZE: {
                            score: 100,
                            reward: {
                                uses: 5,
                                code_prefix: "BRONZE",
                                cooldown: 1800000
                            }
                        },
                        SILVER: {
                            score: 250,
                            reward: {
                                uses: 15,
                                code_prefix: "SILVER",
                                cooldown: 3600000
                            }
                        },
                        GOLD: {
                            score: 500,
                            reward: {
                                uses: 30,
                                code_prefix: "GOLD",
                                cooldown: 7200000
                            }
                        },
                        PLATINUM: {
                            score: 1000,
                            reward: {
                                uses: 50,
                                code_prefix: "PLATINUM",
                                cooldown: null
                            }
                        }
                    }
                }
            };
            fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
            return initialData;
        }
        
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        createBackup(data); // Create backup after successful load
        return data;
    } catch (error) {
        console.error('Error loading data:', error);
        const backup = loadLatestBackup();
        if (backup) {
            console.log('Loaded data from backup');
            return backup;
        }
        return { users: {}, access_codes: {}, game_stats: {} };
    }
}

// Save data with backup
function saveData(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        createBackup(data);
    } catch (error) {
        console.error('Error saving data:', error);
    }
}

// Backup management
function createBackup(data) {
    const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss');
    const backupDir = 'backups';
    const backupPath = path.join(backupDir, `backup_${timestamp}.json`);

    try {
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir);
        }

        fs.writeFileSync(backupPath, JSON.stringify(data, null, 2));

        // Keep only last 24 backups
        const backups = fs.readdirSync(backupDir)
            .filter(file => file.startsWith('backup_'))
            .sort()
            .reverse();

        if (backups.length > 24) {
            backups.slice(24).forEach(backup => {
                fs.unlinkSync(path.join(backupDir, backup));
            });
        }
    } catch (error) {
        console.error('Backup creation failed:', error);
    }
}

function loadLatestBackup() {
    try {
        const backupDir = 'backups';
        if (!fs.existsSync(backupDir)) return null;

        const backups = fs.readdirSync(backupDir)
            .filter(file => file.startsWith('backup_'))
            .sort()
            .reverse();

        if (backups.length === 0) return null;

        const latestBackup = fs.readFileSync(path.join(backupDir, backups[0]), 'utf8');
        return JSON.parse(latestBackup);
    } catch (error) {
        console.error('Error loading backup:', error);
        return null;
    }
}

// Initialize game data
gameData = loadData();

// Session cleanup
setInterval(() => {
    const now = Date.now();
    for (const username in gameData.users) {
        const user = gameData.users[username];
        if (user.lastActivity && (now - user.lastActivity > 24 * 60 * 60 * 1000)) {
            // Reset daily stats for inactive users
            user.dailyUses = 0;
            user.lastActivity = now;
        }
    }
    saveData(gameData);
}, 60 * 60 * 1000); // Check every hour

// Authentication middleware
function requireAuth(req, res, next) {
    if (!req.session.username) {
        return res.status(401).json({ 
            success: false, 
            error: 'Authentication required',
            redirect: '/login'
        });
    }
    
    // Update last activity
    const user = gameData.users[req.session.username];
    if (user) {
        user.lastActivity = Date.now();
        gameData.users[req.session.username] = user;
    }
    
    next();
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

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
        const userId = uuidv4();
        
        gameData.users[username] = {
            id: userId,
            password: hashedPassword,
            created: Date.now(),
            lastLogin: null,
            lastActivity: Date.now(),
            chatHistory: [],
            accessCodes: ['TEST5'],
            gameScore: 0,
            usesRemaining: 5,
            dailyUses: 0,
            rewards: [],
            settings: {
                theme: 'light',
                notifications: true
            }
        };
        
        saveData(gameData);
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
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.json({ success: false, error: 'Invalid username or password' });
        }

        // Update user data
        user.lastLogin = Date.now();
        user.lastActivity = Date.now();
        
        // Reset daily uses at midnight
        const lastLoginDate = new Date(user.lastLogin).setHours(0, 0, 0, 0);
        const today = new Date().setHours(0, 0, 0, 0);
        if (lastLoginDate < today) {
            user.dailyUses = 0;
        }

        gameData.users[username] = user;
        saveData(gameData);

        // Set session
        req.session.username = username;
        req.session.userId = user.id;

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

app.post('/logout', requireAuth, (req, res) => {
    const username = req.session.username;
    if (username && gameData.users[username]) {
        gameData.users[username].lastActivity = Date.now();
        saveData(gameData);
    }
    req.session.destroy();
    res.json({ success: true });
});

app.get('/check-auth', (req, res) => {
    if (!req.session.username) {
        return res.json({ authenticated: false });
    }

    const user = gameData.users[req.session.username];
    if (!user) {
        req.session.destroy();
        return res.json({ authenticated: false });
    }

    res.json({
        authenticated: true,
        username: req.session.username,
        usesRemaining: user.usesRemaining,
        gameScore: user.gameScore,
        settings: user.settings
    });
});

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

        // Update usage and chat history
        user.usesRemaining--;
        user.dailyUses++;
        
        // Add to chat history
        const chatEntry = {
            timestamp: Date.now(),
            message,
            response: completion.choices[0].message.content,
            usesLeft: user.usesRemaining
        };
        
        user.chatHistory.push(chatEntry);

        // Limit chat history
        if (user.chatHistory.length > gameData.system_config.max_chat_history) {
            user.chatHistory = user.chatHistory.slice(-gameData.system_config.max_chat_history);
        }

        gameData.users[username] = user;
        saveData(gameData);

        res.json({
            success: true,
            response: completion.choices[0].message.content,
            usesRemaining: user.usesRemaining,
            dailyUses: user.dailyUses
        });
    } catch (error) {
        console.error('Chat error:', error);
        res.json({ success: false, error: 'Failed to get AI response' });
    }
});

app.post('/game-score', requireAuth, (req, res) => {
    const { score } = req.body;
    const username = req.session.username;
    const user = gameData.users[username];
    
    if (!user) {
        return res.json({ success: false, error: 'User not found' });
    }

    // Initialize or get user's game stats
    if (!gameData.game_stats[username]) {
        gameData.game_stats[username] = {
            highScore: 0,
            totalGames: 0,
            rewards: []
        };
    }

    const stats = gameData.game_stats[username];
    stats.totalGames++;
    
    // Update high score
    if (score > stats.highScore) {
        stats.highScore = score;
    }

    // Update total score
    user.gameScore += score;

    // Check for rewards
    const thresholds = gameData.system_config.score_thresholds;
    Object.entries(thresholds).forEach(([tier, data]) => {
        if (score >= data.score) {
            // Generate unique reward code
            const rewardCode = `${data.reward.code_prefix}_${username}_${Date.now()}`;
            
            // Check if user already has this tier
            if (!user.rewards.includes(tier)) {
                user.rewards.push(tier);
                user.usesRemaining += data.reward.uses;
                
                stats.rewards.push({
                    tier,
                    code: rewardCode,
                    score,
                    earned: Date.now(),
                    uses: data.reward.uses
                });
            }
        }
    });

    // Save updates
    gameData.users[username] = user;
    gameData.game_stats[username] = stats;
    saveData(gameData);

    res.json({
        success: true,
        gameScore: user.gameScore,
        usesRemaining: user.usesRemaining,
        highScore: stats.highScore,
        newRewards: stats.rewards.filter(r => r.earned > Date.now- 5000) // Show rewards earned in last 5 seconds
    });
});

app.post('/redeem-code', requireAuth, (req, res) => {
    const { code } = req.body;
    const username = req.session.username;
    const user = gameData.users[username];

    if (!user) {
        return res.json({ success: false, error: 'User not found' });
    }

    // Check if code exists in global codes
    if (gameData.access_codes[code]) {
        if (user.accessCodes.includes(code)) {
            return res.json({ success: false, error: 'Code already used' });
        }

        const codeData = gameData.access_codes[code];
        user.accessCodes.push(code);

        // Handle different types of codes
        if (codeData.uses === "Infinity") {
            user.usesRemaining = Infinity;
        } else {
            user.usesRemaining += parseInt(codeData.uses);
        }

        gameData.users[username] = user;
        saveData(gameData);

        return res.json({
            success: true,
            usesRemaining: user.usesRemaining,
            message: `Added ${codeData.uses} uses`
        });
    }

    // Check for personal reward codes
    const stats = gameData.game_stats[username];
    if (stats && stats.rewards) {
        const reward = stats.rewards.find(r => r.code === code);
        if (reward && !reward.redeemed) {
            user.usesRemaining += reward.uses;
            reward.redeemed = true;
            
            gameData.users[username] = user;
            gameData.game_stats[username] = stats;
            saveData(gameData);

            return res.json({
                success: true,
                usesRemaining: user.usesRemaining,
                message: `Redeemed reward code for ${reward.uses} uses`
            });
        }
    }

    return res.json({ success: false, error: 'Invalid code' });
});

app.get('/user-data', requireAuth, (req, res) => {
    const username = req.session.username;
    const user = gameData.users[username];
    
    if (!user) {
        return res.json({ success: false, error: 'User not found' });
    }

    // Get user's personal chat history only
    const userData = {
        usesRemaining: user.usesRemaining,
        gameScore: user.gameScore,
        chatHistory: user.chatHistory,
        accessCodes: user.accessCodes,
        rewards: user.rewards,
        settings: user.settings,
        dailyUses: user.dailyUses
    };

    // Get game stats if they exist
    const stats = gameData.game_stats[username] || {
        highScore: 0,
        totalGames: 0,
        rewards: []
    };

    res.json({
        success: true,
        userData,
        gameStats: stats
    });
});

app.post('/clear-chat-history', requireAuth, (req, res) => {
    const username = req.session.username;
    const user = gameData.users[username];
    
    if (!user) {
        return res.json({ success: false, error: 'User not found' });
    }

    user.chatHistory = [];
    gameData.users[username] = user;
    saveData(gameData);

    res.json({ success: true });
});

app.post('/update-settings', requireAuth, (req, res) => {
    const username = req.session.username;
    const user = gameData.users[username];
    const { settings } = req.body;
    
    if (!user) {
        return res.json({ success: false, error: 'User not found' });
    }

    user.settings = { ...user.settings, ...settings };
    gameData.users[username] = user;
    saveData(gameData);

    res.json({
        success: true,
        settings: user.settings
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

// Cleanup old data periodically
setInterval(() => {
    try {
        const now = Date.now();
        const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days

        // Clean up old chat history
        Object.keys(gameData.users).forEach(username => {
            const user = gameData.users[username];
            if (user.chatHistory) {
                user.chatHistory = user.chatHistory.filter(chat => 
                    (now - chat.timestamp) < maxAge
                );
            }
        });

        // Clean up old game stats
        Object.keys(gameData.game_stats).forEach(username => {
            const stats = gameData.game_stats[username];
            if (stats.rewards) {
                stats.rewards = stats.rewards.filter(reward => 
                    !reward.redeemed || (now - reward.earned) < maxAge
                );
            }
        });

        saveData(gameData);
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}, 24 * 60 * 60 * 1000); // Run daily

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('API Key:', process.env.Apikey ? 'Present' : 'Missing');
    console.log('Environment:', process.env.NODE_ENV || 'development');
    console.log('Data file:', DATA_FILE);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM. Saving data and shutting down...');
    saveData(gameData);
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Received SIGINT. Saving data and shutting down...');
    saveData(gameData);
    process.exit(0);
});

// Error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    saveData(gameData);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
