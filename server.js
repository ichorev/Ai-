const express = require('express');
const path = require('path');
const crypto = require('crypto');
const app = express();

// Import OpenAI
const OpenAI = require('openai');

// Check for API key
if (!process.env.Apikey) {
    console.error('ERROR: Apikey environment variable is missing');
    process.exit(1);
}

// Initialize OpenAI with API key from environment variable
const openai = new OpenAI({
    apiKey: process.env.Apikey.trim()
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Data Storage
const users = new Map();          // Store user data
const accessCodes = new Map();    // Public codes
const personalCodes = new Map();  // User-specific codes
const usageTracking = new Map();  // Track code usage

// Initialize standard access code
accessCodes.set('TEST5', { uses: 5, tier: 'BASIC' });

// Game reward thresholds
const REWARD_TIERS = {
    BRONZE: { points: 100, uses: 10 },
    SILVER: { points: 250, uses: 25 },
    GOLD: { points: 500, uses: 50 },
    PLATINUM: { points: 1000, uses: 100 }
};

// Generate unique user ID
function generateUserId() {
    return crypto.randomBytes(8).toString('hex');
}

// Generate secure personal code
function generatePersonalCode(userId, tier) {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    const hash = crypto.createHash('sha256')
        .update(`${userId}-${tier}-${timestamp}-${random}`)
        .digest('hex')
        .substring(0, 8);
    return `${tier}_${hash}_${random}`;
}

// User session initialization
app.post('/init-user', (req, res) => {
    const userId = generateUserId();
    users.set(userId, {
        created: Date.now(),
        score: 0,
        earnedCodes: [],
        lastPlayed: null
    });
    res.json({ userId });
});

// Handle game score and reward generation
app.post('/game-score', (req, res) => {
    const { userId, score } = req.body;
    
    if (!users.has(userId)) {
        return res.json({ success: false, error: 'Invalid user' });
    }

    const userData = users.get(userId);
    userData.score += score;
    userData.lastPlayed = Date.now();

    // Check for rewards
    let newReward = null;
    for (const [tier, data] of Object.entries(REWARD_TIERS)) {
        if (userData.score >= data.points && 
            !userData.earnedCodes.some(code => code.tier === tier)) {
            
            const newCode = generatePersonalCode(userId, tier);
            const rewardData = {
                code: newCode,
                tier: tier,
                uses: data.uses,
                earned: Date.now()
            };
            
            personalCodes.set(newCode, {
                userId,
                ...rewardData
            });
            
            userData.earnedCodes.push(rewardData);
            newReward = rewardData;
            break;
        }
    }

    // Update user data
    users.set(userId, userData);

    // Calculate next reward
    let nextReward = null;
    for (const [tier, data] of Object.entries(REWARD_TIERS)) {
        if (userData.score < data.points) {
            nextReward = {
                tier,
                pointsNeeded: data.points - userData.score,
                total: data.points
            };
            break;
        }
    }

    res.json({
        success: true,
        totalScore: userData.score,
        newReward,
        nextReward,
        earnedCodes: userData.earnedCodes
    });
});

app.post('/verify-access', (req, res) => {
    const { accessCode, userId } = req.body;

    // Check personal codes first
    if (personalCodes.has(accessCode)) {
        const codeData = personalCodes.get(accessCode);
        if (codeData.userId === userId) {
            if (!usageTracking.has(accessCode)) {
                usageTracking.set(accessCode, {
                    remainingUses: codeData.uses,
                    tier: codeData.tier
                });
            }
            const tracking = usageTracking.get(accessCode);
            if (tracking.remainingUses > 0) {
                res.json({
                    success: true,
                    usesLeft: tracking.remainingUses,
                    tier: codeData.tier,
                    personal: true
                });
                return;
            }
        }
    }

    // Check public codes
    if (accessCodes.has(accessCode)) {
        if (!usageTracking.has(accessCode)) {
            const codeData = accessCodes.get(accessCode);
            usageTracking.set(accessCode, {
                remainingUses: codeData.uses,
                tier: codeData.tier
            });
        }
        
        const tracking = usageTracking.get(accessCode);
        if (tracking.remainingUses > 0) {
            res.json({
                success: true,
                usesLeft: tracking.remainingUses,
                tier: tracking.tier,
                personal: false
            });
            return;
        }
    }

    res.json({ success: false });
});

app.post('/chat', async (req, res) => {
    const { message, accessCode, userId } = req.body;

    // Verify access code and usage
    const tracking = usageTracking.get(accessCode);
    if (!tracking || tracking.remainingUses <= 0) {
        return res.json({ success: false, error: 'Invalid or expired code' });
    }

    // Verify personal code ownership
    if (personalCodes.has(accessCode)) {
        const codeData = personalCodes.get(accessCode);
        if (codeData.userId !== userId) {
            return res.json({ success: false, error: 'Invalid personal code' });
        }
    }

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4-0125-preview",
            messages: [{ role: "user", content: message }],
            max_tokens: 4000,
            temperature: 0.7,
        });

        // Update usage
        tracking.remainingUses--;
        usageTracking.set(accessCode, tracking);

        res.json({
            success: true,
            response: completion.choices[0].message.content,
            usesLeft: tracking.remainingUses,
            tier: tracking.tier
        });
    } catch (error) {
        console.error('OpenAI API Error:', error);
        res.json({
            success: false,
            error: 'Error communicating with ChatGPT'
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('API Key:', process.env.Apikey ? 'Present' : 'Missing');
});
