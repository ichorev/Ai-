const express = require('express');
const path = require('path');
const { randomBytes, createHash } = require('crypto');
const { v4: uuidv4 } = require('uuid');

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

// Data storage
const accessCodes = new Map();
const usageTracking = new Map();
const gameScores = new Map();
const personalCodes = new Map();
const userSessions = new Map();

// Initialize default codes
accessCodes.set('TEST5', { uses: 5, tier: 'BASIC' });

// Game reward tiers
const REWARD_TIERS = {
    BRONZE: { score: 100, uses: 10 },
    SILVER: { score: 250, uses: 25 },
    GOLD: { score: 500, uses: 50 },
    PLATINUM: { score: 1000, uses: 100 }
};

function generatePersonalCode(userId, tier) {
    const timestamp = Date.now();
    const random = randomBytes(4).toString('hex');
    const hash = createHash('sha256')
        .update(`${userId}-${tier}-${timestamp}-${random}`)
        .digest('hex')
        .substring(0, 8);
    return `${tier}_${hash}_${random}`;
}

function validatePersonalCode(code, userId) {
    const codeData = personalCodes.get(code);
    return codeData && codeData.userId === userId;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/init-user', (req, res) => {
    const userId = uuidv4();
    userSessions.set(userId, {
        created: Date.now(),
        score: 0,
        earnedCodes: [],
        lastPlayed: null
    });
    res.json({ userId });
});

app.post('/verify-access', (req, res) => {
    const { accessCode, userId } = req.body;
    
    // Check personal codes first
    if (personalCodes.has(accessCode)) {
        if (validatePersonalCode(accessCode, userId)) {
            const codeData = personalCodes.get(accessCode);
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

app.post('/game-score', (req, res) => {
    const { userId, score } = req.body;
    
    const userData = userSessions.get(userId);
    if (!userData) {
        return res.json({ success: false, error: 'Invalid user session' });
    }

    userData.score += score;
    userData.lastPlayed = Date.now();

    // Check for rewards
    let newReward = null;
    for (const [tier, data] of Object.entries(REWARD_TIERS)) {
        if (userData.score >= data.score && 
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

    userSessions.set(userId, userData);

    // Calculate next reward
    let nextReward = null;
    for (const [tier, data] of Object.entries(REWARD_TIERS)) {
        if (userData.score < data.score) {
            nextReward = {
                tier,
                pointsNeeded: data.score - userData.score,
                total: data.score
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

app.post('/chat', async (req, res) => {
    const { message, accessCode, userId } = req.body;

    if (!usageTracking.has(accessCode)) {
        res.json({ success: false, error: 'Invalid access code' });
        return;
    }

    // Verify personal code ownership
    if (personalCodes.has(accessCode)) {
        if (!validatePersonalCode(accessCode, userId)) {
            res.json({ success: false, error: 'Invalid personal code' });
            return;
        }
    }

    const tracking = usageTracking.get(accessCode);
    if (tracking.remainingUses <= 0) {
        res.json({ success: false, error: 'No uses remaining' });
        return;
    }

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4-0125-preview",
            messages: [{ role: "user", content: message }],
            max_tokens: 4000,
            temperature: 0.7,
        });

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
