const express = require('express');
const path = require('path');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

// Import OpenAI
const OpenAI = require('openai');

// Initialize Firebase
const { initializeApp } = require('firebase/app');
const { 
    getDatabase, 
    ref, 
    set, 
    get, 
    update, 
    child,
    push,
    remove 
} = require('firebase/database');

// Firebase Configuration
const firebaseConfig = {
    apiKey: "AIzaSyCcmRGmdwB1fBd59RUs0YFRCrVf3YwKnE8",
    authDomain: "aiapp-7d391.firebaseapp.com",
    databaseURL: "https://aiapp-7d391-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "aiapp-7d391",
    storageBucket: "aiapp-7d391.firebasestorage.app",
    messagingSenderId: "304975349762",
    appId: "1:304975349762:web:72d2c99f611a0c3e28ff1b"
};

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

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
app.use(cookieParser());

// Rate limiting configuration with custom error handling
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    trustProxy: true,
    handler: (req, res) => {
        res.status(429).json({
            success: false,
            error: 'Too many requests, please try again later.',
            retryAfter: Math.ceil(req.rateLimit.resetTime - Date.now() / 1000)
        });
    },
    skip: (req) => {
        // Skip rate limiting for health checks
        return req.path === '/health';
    }
});

app.use(limiter);

// Session configuration with secure settings
app.use(session({
    secret: process.env.Apikey || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { 
        secure: true,
        sameSite: 'none',
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        httpOnly: true
    },
    name: 'sessionId' // Custom session cookie name
}));

// Game and Chat Configuration
const CONFIG = {
    GAME: {
        REWARD_THRESHOLDS: {
            BRONZE: { score: 100, uses: 5, cooldown: 1800000 }, // 30 minutes
            SILVER: { score: 250, uses: 15, cooldown: 3600000 }, // 1 hour
            GOLD: { score: 500, uses: 30, cooldown: 7200000 }, // 2 hours
            PLATINUM: { score: 1000, uses: 50, cooldown: null } // No cooldown
        },
        MAX_DAILY_REWARDS: 10,
        MIN_SCORE: 10,
        COMBO_MULTIPLIERS: {
            3: 1.5,
            5: 2,
            10: 3
        }
    },
    CHAT: {
        MAX_HISTORY: 50,
        MAX_MESSAGE_LENGTH: 1000,
        MODEL: "gpt-4-0125-preview",
        MAX_TOKENS: 4000,
        TEMPERATURE: 0.7,
        HISTORY_RETENTION_DAYS: 30
    },
    USER: {
        DEFAULT_USES: 5,
        MAX_LOGIN_ATTEMPTS: 5,
        LOCKOUT_DURATION: 900000, // 15 minutes
        SESSION_TIMEOUT: 3600000 // 1 hour
    }
};

// Firebase Data Management Functions
async function saveToFirebase(path, data) {
    try {
        const dataRef = ref(database, path);
        await set(dataRef, data);
        return true;
    } catch (error) {
        console.error(`Firebase save error at ${path}:`, error);
        return false;
    }
}

async function getFromFirebase(path) {
    try {
        const dataRef = ref(database, path);
        const snapshot = await get(dataRef);
        return snapshot.exists() ? snapshot.val() : null;
    } catch (error) {
        console.error(`Firebase get error at ${path}:`, error);
        return null;
    }
}

async function updateInFirebase(path, updates) {
    try {
        const dataRef = ref(database, path);
        await update(dataRef, updates);
        return true;
    } catch (error) {
        console.error(`Firebase update error at ${path}:`, error);
        return false;
    }
}

// User Session Management
const loginAttempts = new Map();

function updateLoginAttempts(username, success) {
    const attempts = loginAttempts.get(username) || { count: 0, lastAttempt: 0 };
    
    if (success) {
        loginAttempts.delete(username);
    } else {
        attempts.count++;
        attempts.lastAttempt = Date.now();
        loginAttempts.set(username, attempts);
    }
    
    return attempts;
}

function isAccountLocked(username) {
    const attempts = loginAttempts.get(username);
    if (!attempts) return false;
    
    if (attempts.count >= CONFIG.USER.MAX_LOGIN_ATTEMPTS) {
        const timeElapsed = Date.now() - attempts.lastAttempt;
        if (timeElapsed < CONFIG.USER.LOCKOUT_DURATION) {
            return true;
        }
        loginAttempts.delete(username);
    }
    return false;
}

// Auth Middleware
async function requireAuth(req, res, next) {
    if (!req.session.username) {
        return res.status(401).json({ 
            success: false, 
            error: 'Authentication required' 
        });
    }

    // Verify user exists in Firebase
    const userData = await getFromFirebase(`users/${req.session.username}`);
    if (!userData) {
        req.session.destroy();
        return res.status(401).json({
            success: false,
            error: 'User session invalid'
        });
    }

    // Update last activity
    await updateInFirebase(`users/${req.session.username}`, {
        lastActive: Date.now()
    });

    next();
}

// Activity Monitor Function
async function monitorActivity(username) {
    const now = Date.now();
    const userData = await getFromFirebase(`users/${username}`);
    
    if (userData) {
        // Reset daily stats at midnight
        const lastActiveDate = new Date(userData.lastActive || 0).setHours(0, 0, 0, 0);
        const today = new Date().setHours(0, 0, 0, 0);
        
        if (lastActiveDate < today) {
            await updateInFirebase(`users/${username}`, {
                dailyRewards: 0,
                dailyUses: 0
            });
        }
    }
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Registration Route
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

    try {
        // Check if username exists
        const existingUser = await getFromFirebase(`users/${username}`);
        if (existingUser) {
            return res.json({ success: false, error: 'Username already exists' });
        }

        // Create new user
        const hashedPassword = await require('bcryptjs').hash(password, 10);
        const userData = {
            id: uuidv4(),
            password: hashedPassword,
            created: Date.now(),
            lastLogin: null,
            chatHistory: [],
            accessCodes: ['TEST5'],
            gameScore: 0,
            usesRemaining: CONFIG.USER.DEFAULT_USES,
            rewards: [],
            settings: {
                theme: 'light',
                notifications: true
            }
        };

        const saved = await saveToFirebase(`users/${username}`, userData);
        if (!saved) {
            return res.json({ success: false, error: 'Registration failed' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Registration error:', error);
        res.json({ success: false, error: 'Registration failed' });
    }
});

// Login Route
app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    // Check account lockout
    if (isAccountLocked(username)) {
        const lockoutRemaining = CONFIG.USER.LOCKOUT_DURATION - 
            (Date.now() - loginAttempts.get(username).lastAttempt);
            
        return res.json({ 
            success: false, 
            error: `Account temporarily locked. Try again in ${Math.ceil(lockoutRemaining / 60000)} minutes.`
        });
    }

    try {
        const userData = await getFromFirebase(`users/${username}`);
        
        if (!userData) {
            updateLoginAttempts(username, false);
            return res.json({ success: false, error: 'Invalid username or password' });
        }

        const validPassword = await require('bcryptjs').compare(password, userData.password);
        
        if (!validPassword) {
            const attempts = updateLoginAttempts(username, false);
            const remainingAttempts = CONFIG.USER.MAX_LOGIN_ATTEMPTS - attempts.count;
            
            return res.json({ 
                success: false, 
                error: `Invalid password. ${remainingAttempts} attempts remaining.`
            });
        }

        // Successful login
        updateLoginAttempts(username, true);
        
        // Update user data
        await updateInFirebase(`users/${username}`, {
            lastLogin: Date.now(),
            lastActive: Date.now(),
            loginCount: (userData.loginCount || 0) + 1
        });

        // Set session
        req.session.username = username;
        
        res.json({
            success: true,
            username,
            usesRemaining: userData.usesRemaining,
            gameScore: userData.gameScore,
            settings: userData.settings
        });

    } catch (error) {
        console.error('Login error:', error);
        res.json({ success: false, error: 'Login failed' });
    }
});

// Chat Route
app.post('/chat', requireAuth, async (req, res) => {
    const username = req.session.username;
    const { message } = req.body;

    if (!message || message.length > CONFIG.CHAT.MAX_MESSAGE_LENGTH) {
        return res.json({ 
            success: false, 
            error: `Message must be between 1 and ${CONFIG.CHAT.MAX_MESSAGE_LENGTH} characters` 
        });
    }

    try {
        // Get user data
        const userData = await getFromFirebase(`users/${username}`);
        
        if (!userData || userData.usesRemaining <= 0) {
            return res.json({ 
                success: false, 
                error: 'No uses remaining. Play games to earn more!' 
            });
        }

        // Get AI response
        const completion = await openai.chat.completions.create({
            model: CONFIG.CHAT.MODEL,
            messages: [{ role: "user", content: message }],
            max_tokens: CONFIG.CHAT.MAX_TOKENS,
            temperature: CONFIG.CHAT.TEMPERATURE,
        });

        // Update chat history
        const chatHistory = userData.chatHistory || [];
        const newChat = {
            id: uuidv4(),
            timestamp: Date.now(),
            message,
            response: completion.choices[0].message.content,
            usesLeft: userData.usesRemaining - 1
        };
        
        chatHistory.push(newChat);

        // Limit chat history
        if (chatHistory.length > CONFIG.CHAT.MAX_HISTORY) {
            chatHistory.splice(0, chatHistory.length - CONFIG.CHAT.MAX_HISTORY);
        }

        // Update user data
        const updates = {
            usesRemaining: userData.usesRemaining - 1,
            chatHistory,
            lastActive: Date.now(),
            totalChats: (userData.totalChats || 0) + 1
        };

        await updateInFirebase(`users/${username}`, updates);

        res.json({
            success: true,
            response: completion.choices[0].message.content,
            usesRemaining: updates.usesRemaining,
            chatId: newChat.id
        });

    } catch (error) {
        console.error('Chat error:', error);
        res.json({ success: false, error: 'Failed to get AI response' });
    }
});

// Game Score Route
app.post('/game-score', requireAuth, async (req, res) => {
    const { score } = req.body;
    const username = req.session.username;

    if (typeof score !== 'number' || score < CONFIG.GAME.MIN_SCORE) {
        return res.json({ success: false, error: 'Invalid score' });
    }

    try {
        const userData = await getFromFirebase(`users/${username}`);
        
        if (!userData) {
            return res.json({ success: false, error: 'User not found' });
        }

        const now = Date.now();
        const gameStats = userData.gameStats || {
            highScore: 0,
            totalGames: 0,
            lastReward: 0,
            comboCount: 0
        };

        // Check for combo bonus
        let comboMultiplier = 1;
        if (score > gameStats.highScore) {
            gameStats.comboCount++;
            const combo = Object.entries(CONFIG.GAME.COMBO_MULTIPLIERS)
                .reverse()
                .find(([streak]) => gameStats.comboCount >= parseInt(streak));
            
            if (combo) {
                comboMultiplier = combo[1];
            }
        } else {
            gameStats.comboCount = 0;
        }

        // Calculate rewards
        let rewardsEarned = [];
        let additionalUses = 0;

        // Check daily reward limit
        const dailyRewards = userData.dailyRewards || 0;
        const canEarnRewards = dailyRewards < CONFIG.GAME.MAX_DAILY_REWARDS;

        if (canEarnRewards) {
            // Check each reward threshold
            Object.entries(CONFIG.GAME.REWARD_THRESHOLDS).forEach(([tier, data]) => {
                const lastRewardTime = userData.lastReward || 0;
                const cooldownPassed = !data.cooldown || (now - lastRewardTime >= data.cooldown);

                if (score >= data.score && cooldownPassed && !userData.rewards.includes(tier)) {
                    const adjustedUses = Math.floor(data.uses * comboMultiplier);
                    userData.rewards.push(tier);
                    additionalUses += adjustedUses;
                    rewardsEarned.push({
                        tier,
                        uses: adjustedUses,
                        withCombo: comboMultiplier > 1
                    });
                }
            });
        }

        // Update game stats
        gameStats.totalGames++;
        gameStats.highScore = Math.max(gameStats.highScore, score);
        gameStats.lastPlayed = now;

        // Update user data
        const updates = {
            gameScore: (userData.gameScore || 0) + score,
            usesRemaining: (userData.usesRemaining || 0) + additionalUses,
            gameStats,
            rewards: userData.rewards,
            lastActive: now,
            dailyRewards: rewardsEarned.length > 0 ? dailyRewards + 1 : dailyRewards
        };

        if (rewardsEarned.length > 0) {
            updates.lastReward = now;
        }

        await updateInFirebase(`users/${username}`, updates);

        res.json({
            success: true,
            score,
            totalScore: updates.gameScore,
            highScore: gameStats.highScore,
            rewardsEarned,
            comboMultiplier,
            comboCount: gameStats.comboCount,
            usesRemaining: updates.usesRemaining,
            dailyRewardsRemaining: CONFIG.GAME.MAX_DAILY_REWARDS - updates.dailyRewards
        });

    } catch (error) {
        console.error('Game score error:', error);
        res.json({ success: false, error: 'Failed to update game score' });
    }
});

// User Data Route
app.get('/user-data', requireAuth, async (req, res) => {
    const username = req.session.username;

    try {
        const userData = await getFromFirebase(`users/${username}`);
        
        if (!userData) {
            return res.json({ success: false, error: 'User not found' });
        }

        // Monitor and update daily activities
        await monitorActivity(username);

        // Remove sensitive data
        const { password, ...safeData } = userData;

        // Calculate time until next rewards
        const nextRewards = {};
        if (userData.lastReward) {
            Object.entries(CONFIG.GAME.REWARD_THRESHOLDS).forEach(([tier, data]) => {
                if (data.cooldown && !userData.rewards.includes(tier)) {
                    const timeLeft = Math.max(0, data.cooldown - (Date.now() - userData.lastReward));
                    if (timeLeft > 0) {
                        nextRewards[tier] = timeLeft;
                    }
                }
            });
        }

        res.json({
            success: true,
            data: {
                ...safeData,
                nextRewards,
                dailyRewardsRemaining: CONFIG.GAME.MAX_DAILY_REWARDS - (userData.dailyRewards || 0)
            }
        });

    } catch (error) {
        console.error('Error fetching user data:', error);
        res.json({ success: false, error: 'Failed to fetch user data' });
    }
});

// Clear Chat History Route
app.post('/clear-chat', requireAuth, async (req, res) => {
    const username = req.session.username;

    try {
        await updateInFirebase(`users/${username}/chatHistory`, []);
        res.json({ success: true });
    } catch (error) {
        console.error('Clear chat error:', error);
        res.json({ success: false, error: 'Failed to clear chat history' });
    }
});

// User Settings Route
app.post('/update-settings', requireAuth, async (req, res) => {
    const username = req.session.username;
    const { settings } = req.body;

    try {
        await updateInFirebase(`users/${username}/settings`, settings);
        res.json({ success: true, settings });
    } catch (error) {
        console.error('Settings update error:', error);
        res.json({ success: false, error: 'Failed to update settings' });
    }
});

// Logout Route
app.post('/logout', async (req, res) => {
    const username = req.session.username;
    
    try {
        if (username) {
            await updateInFirebase(`users/${username}`, {
                lastLogout: Date.now()
            });
        }
        
        req.session.destroy();
        res.json({ success: true });
    } catch (error) {
        console.error('Logout error:', error);
        res.json({ success: false, error: 'Logout failed' });
    }
});

// Health Check Route
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: Date.now(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development',
        firebase: firebaseApp ? 'connected' : 'disconnected'
    });
});

// Error Handling Middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({
        success: false,
        error: 'An internal server error occurred',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Clean up old data periodically
setInterval(async () => {
    try {
        const users = await getFromFirebase('users');
        const now = Date.now();

        for (const [username, userData] of Object.entries(users)) {
            // Clean up old chat history
            if (userData.chatHistory) {
                userData.chatHistory = userData.chatHistory.filter(chat => 
                    (now - chat.timestamp) < (CONFIG.CHAT.HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000)
                );
            }

            // Reset daily stats if needed
            const lastActiveDate = new Date(userData.lastActive || 0).setHours(0, 0, 0, 0);
            const today = new Date().setHours(0, 0, 0, 0);
            
            if (lastActiveDate < today) {
                userData.dailyRewards = 0;
                userData.dailyUses = 0;
            }

            await updateInFirebase(`users/${username}`, userData);
        }
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}, 24 * 60 * 60 * 1000); // Run daily

// Start server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('API Key:', process.env.Apikey ? 'Present' : 'Missing');
    console.log('Environment:', process.env.NODE_ENV || 'development');
    console.log('Firebase:', firebaseApp ? 'Connected' : 'Not Connected');
});

// Graceful Shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

// Error Handlers
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    server.close(() => process.exit(1));
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = app;
